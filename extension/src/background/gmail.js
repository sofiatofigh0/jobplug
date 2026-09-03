import '../common/constants.js';
import '../common/util.js';
import { api } from './auth.js';
import { classifyEmail, matchesApplication } from './classifier.js';

const { C, U } = globalThis.JAT;

// ---------------------------------------------------------------------------
// Message decoding
// ---------------------------------------------------------------------------
function b64urlDecode(data) {
  if (!data) return '';
  try {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { return ''; }
}

function stripHtml(html) {
  return U.clean(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
  );
}

/** Depth-first walk of the MIME tree, preferring text/plain over text/html. */
function extractBody(payload) {
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const data = part.body && part.body.data;
    if (data) {
      if (mime === 'text/plain' && !plain) plain = b64urlDecode(data);
      else if (mime === 'text/html' && !html) html = b64urlDecode(data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  const text = plain || (html ? stripHtml(html) : '');
  // Quoted history restates old rejections; only the top of the reply matters.
  return U.clean(text.split(/\n\s*(?:On .{0,80}wrote:|-{3,}\s*Original Message|From:\s)/i)[0]).slice(0, 20000);
}

function header(msg, name) {
  const hs = (msg.payload && msg.payload.headers) || [];
  const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function toMail(msg) {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(msg, 'From'),
    to: header(msg, 'To'),
    subject: header(msg, 'Subject'),
    snippet: msg.snippet || '',
    body: extractBody(msg.payload),
    listUnsubscribe: header(msg, 'List-Unsubscribe'),
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '',
    labelIds: msg.labelIds || [],
  };
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------
function quote(s) {
  return `"${String(s).replace(/"/g, '')}"`;
}

/**
 * Query for one application: mail that arrived after you applied, from the
 * company's own domain or mentioning the company by name.
 */
function queryFor(app, sinceEpoch, lookbackDays) {
  const clauses = [];
  if (app.companyDomain) clauses.push(`from:${U.rootDomain(app.companyDomain)}`);
  const name = U.clean(app.company || '').replace(/[,.]/g, '');
  if (name && name.length >= 3) {
    clauses.push(quote(name));
    // ATS mail arrives from the vendor's domain but names the employer.
    clauses.push(`(from:(${C.ALL_ATS_MAIL_DOMAINS.slice(0, 12).join(' OR ')}) ${quote(name.split(' ')[0])})`);
  }
  if (!clauses.length) return null;

  const applied = Math.floor(new Date(app.appliedAt).getTime() / 1000) - 86400;
  const after = Math.max(applied, sinceEpoch || 0);
  return [
    `after:${after}`,
    `newer_than:${lookbackDays}d`,
    '-in:spam',
    '-in:trash',
    '-in:chats',
    '-from:me',
    `(${clauses.join(' OR ')})`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
async function listMessages(q, maxResults = 12) {
  const url = `${C.GMAIL_API}/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`;
  const res = await api(url);
  return res.messages || [];
}

async function getMessage(id) {
  return api(`${C.GMAIL_API}/messages/${id}?format=full`);
}

/**
 * Scan Gmail for replies to the given applications.
 *
 * Returns one update per application that moved, plus every classified email
 * for the audit log. Applications in a terminal state are skipped, and message
 * IDs already seen are never re-fetched.
 *
 * @param {Array} apps        applications to check
 * @param {object} settings
 * @param {function} onProgress
 */
export async function scanForReplies(apps, settings, onProgress) {
  const lookback = settings.gmailLookbackDays || 120;
  const cutoff = Date.now() - lookback * 86400000;
  const sinceEpoch = settings.lastGmailSync
    ? Math.floor((settings.lastGmailSync - 3 * 86400000) / 1000)   // 3-day overlap absorbs late deliveries
    : 0;

  const open = apps.filter((a) => {
    if (C.TERMINAL_STATUSES.has(a.status)) return false;
    const t = new Date(a.appliedAt).getTime();
    return isFinite(t) && t >= cutoff;
  });

  const updates = [];
  const events = [];
  const seenMessage = new Set();
  let checked = 0;

  for (const app of open) {
    const q = queryFor(app, sinceEpoch, lookback);
    if (!q) continue;

    let stubs = [];
    try {
      stubs = await listMessages(q);
    } catch (err) {
      if (err.status === 401 || err.needsAuth) throw err;
      console.warn('[JobPlug] gmail list failed for', app.company, err.message);
      continue;
    }

    const known = new Set(app.emailIds || []);
    const fresh = stubs.filter((s) => !known.has(s.id) && !seenMessage.has(s.id)).slice(0, 8);

    let best = null;
    const appEmailIds = [];

    for (const stub of fresh) {
      seenMessage.add(stub.id);
      let msg;
      try { msg = await getMessage(stub.id); } catch { continue; }
      const mail = toMail(msg);
      if (!mail.from) continue;
      if (mail.labelIds.includes('SENT') || mail.labelIds.includes('DRAFT')) continue;

      const match = matchesApplication(mail, app);
      if (!match.matched) continue;

      const verdict = classifyEmail(mail);
      appEmailIds.push(mail.id);

      events.push({
        receivedAt: mail.receivedAt,
        company: app.company,
        position: app.position,
        from: mail.from,
        subject: mail.subject,
        classification: verdict.category,
        confidence: verdict.confidence,
        threadId: mail.threadId,
        appId: app.id,
      });

      if (verdict.category === 'NOISE' || verdict.category === 'OUTREACH' || verdict.category === 'OTHER') continue;
      if (!best || rank(verdict) > rank(best.verdict)) best = { mail, verdict, matchScore: match.score };
    }

    if (appEmailIds.length) {
      const patch = { id: app.id, emailIds: appEmailIds };
      const latest = latestOf(events.filter((e) => e.appId === app.id));
      if (latest) {
        patch.lastEmailAt = latest.receivedAt;
        patch.lastEmailSubject = latest.subject;
      }
      if (best) {
        patch.status = best.verdict.status;
        patch.threadId = best.mail.threadId;
        patch.firstResponseAt = best.mail.receivedAt;
        if (best.verdict.isInvite) {
          patch.gotInterview = true;
          patch.interviewInviteAt = best.mail.receivedAt;
        }
        patch.classification = best.verdict.category;
        patch.confidence = best.verdict.confidence;
      }
      updates.push(patch);
    }

    checked++;
    if (onProgress && checked % 5 === 0) onProgress({ checked, total: open.length });
  }

  return { updates, events, checked, considered: open.length };
}

/** Order in which competing classifications for one application win. */
function rank(v) {
  const order = { ACKNOWLEDGEMENT: 1, ASSESSMENT: 2, INTERVIEW_INVITE: 3, OFFER: 4, REJECTION: 5 };
  return order[v.category] || 0;
}

function latestOf(list) {
  return list.slice().sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0] || null;
}

/** One-off: confirm Gmail scope actually works, used by the Options page. */
export async function gmailProfile() {
  return api(`${C.GMAIL_API}/profile`);
}
