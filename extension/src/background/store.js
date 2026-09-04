import '../common/constants.js';
import '../common/util.js';

const { C, U } = globalThis.JAT;

const DEFAULTS = {
  authMode: 'chrome',
  oauthClientId: '',
  oauthClientSecret: '',
  spreadsheetId: '',
  spreadsheetUrl: '',
  autoCapture: true,
  confirmBeforeLogging: false,
  notifications: true,
  gmailEnabled: true,
  gmailPollMinutes: 30,
  gmailLookbackDays: 120,
  ghostAfterDays: C.GHOST_AFTER_DAYS,
  resumeAliases: [],          // [{ match: 'sofia_backend_v3.pdf', label: 'Backend v3' }]
  excludeHosts: [],           // hosts to never capture on
  enrichEnabled: false,
  enrichProvider: '',         // 'crunchbase' | 'custom'
  enrichApiKey: '',
  enrichEndpoint: '',
  lastGmailSync: 0,
  lastSheetSync: 0,
  sheetFormattedVersion: 0,
  schemaVersion: C.SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
export async function getApps() {
  const { apps } = await chrome.storage.local.get('apps');
  return apps || {};
}

export async function getAppList() {
  const apps = await getApps();
  return Object.values(apps).sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt));
}

async function putApps(apps) {
  await chrome.storage.local.set({ apps });
}

/**
 * Stable job reference from a posting URL.
 *
 * Confirmation suffixes are stripped so /jobs/8088720 and
 * /jobs/8088720/confirmation resolve to the same job and merge into one row
 * rather than creating two.
 */
function jobRef(url) {
  if (!url) return '';
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
      .filter((s) => !/^(confirmation|confirmed|thanks|thank[-_]?you|success|applied|post[-_]?apply|application)$/i.test(s));
    const ids = segs.filter((s) => /^\d{4,}$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s));
    return ids.length ? ids[ids.length - 1] : segs.join('/');
  } catch { return ''; }
}

/**
 * Dedupe identity for an application. Company + role + board is stable across
 * the JD page, the apply iframe and any later Gmail update, which URL is not.
 *
 * When the role is missing the company alone is NOT identity — a confirmation
 * page often names the employer but not the job, and keying on company would
 * collapse every role at that employer into one row, silently overwriting each
 * application with the next. So the job id from the URL joins the key.
 */
export function makeId(rec) {
  const company = U.normCompany(rec.company || '');
  const title = U.normTitle(rec.position || '');
  const board = rec.boardId || rec.board || '';
  if (company && title) return 'a_' + U.hash(`${company}|${title}|${board}`);

  const ref = jobRef(rec.jdUrl || rec.frameUrl || '');
  if (company || title) return 'a_' + U.hash(`${company}|${title}|${board}|${ref}`);
  return 'a_' + U.hash(`url|${ref || (rec.jdUrl || '').split('?')[0]}`);
}

export async function getApp(id) {
  return (await getApps())[id] || null;
}

/**
 * Insert or merge an application.
 * Merge policy: existing non-empty values win over incoming empties, incoming
 * non-empty values win over existing empties, and `status` only ever advances
 * (see mergeStatus).
 */
export async function upsertApp(incoming, { preferIncoming = false } = {}) {
  const apps = await getApps();
  const id = incoming.id || makeId(incoming);
  const existing = apps[id];
  const merged = existing ? mergeRecords(existing, incoming, preferIncoming) : normaliseNew(incoming, id);
  merged.id = id;
  merged.updatedAt = new Date().toISOString();
  merged.dirty = true;
  apps[id] = merged;
  await putApps(apps);
  return { app: merged, created: !existing };
}

function normaliseNew(rec, id) {
  const out = {
    id,
    appliedAt: rec.appliedAt || new Date().toISOString(),
    company: U.clean(rec.company || ''),
    position: U.clean(rec.position || ''),
    jdUrl: rec.jdUrl || '',
    board: rec.board || '',
    boardId: rec.boardId || '',
    location: U.clean(rec.location || ''),
    workMode: rec.workMode || '',
    salaryMin: numOrNull(rec.salaryMin),
    salaryMax: numOrNull(rec.salaryMax),
    salaryRaw: U.clean(rec.salaryRaw || ''),
    salaryCurrency: rec.salaryCurrency || '',
    resumeName: U.clean(rec.resumeName || ''),
    resumeLabel: '',
    coverLetter: U.clean(rec.coverLetter || ''),
    companyStage: U.clean(rec.companyStage || ''),
    valuation: numOrNull(rec.valuation),
    totalRaised: numOrNull(rec.totalRaised),
    lastRound: U.clean(rec.lastRound || ''),
    lastRoundDate: U.clean(rec.lastRoundDate || ''),
    headcount: U.clean(rec.headcount || ''),
    industry: U.clean(rec.industry || ''),
    companyDomain: (rec.companyDomain || '').toLowerCase(),
    status: rec.status || C.STATUS.APPLIED,
    gotInterview: rec.gotInterview || false,
    firstResponseAt: rec.firstResponseAt || '',
    interviewInviteAt: rec.interviewInviteAt || '',
    lastEmailAt: rec.lastEmailAt || '',
    lastEmailSubject: U.clean(rec.lastEmailSubject || ''),
    threadId: rec.threadId || '',
    notes: U.clean(rec.notes || ''),
    source: rec.source || 'auto',
    evidence: rec.evidence || null,
    emailIds: rec.emailIds || [],
    rowIndex: rec.rowIndex || null,
    updatedAt: new Date().toISOString(),
  };
  return out;
}

const SCALARS = [
  'company', 'position', 'jdUrl', 'board', 'boardId', 'location', 'workMode',
  'salaryRaw', 'salaryCurrency', 'resumeName', 'resumeLabel', 'coverLetter',
  'companyStage', 'lastRound', 'lastRoundDate', 'headcount', 'industry',
  'companyDomain', 'notes', 'threadId', 'lastEmailSubject',
];
const NUMBERS = ['salaryMin', 'salaryMax', 'valuation', 'totalRaised'];
const DATES = ['firstResponseAt', 'interviewInviteAt', 'lastEmailAt'];

function mergeRecords(existing, incoming, preferIncoming) {
  const out = { ...existing };

  for (const k of SCALARS) {
    const inc = U.clean(incoming[k] == null ? '' : incoming[k]);
    if (!inc) continue;
    if (preferIncoming || !out[k]) out[k] = inc;
  }
  for (const k of NUMBERS) {
    const inc = numOrNull(incoming[k]);
    if (inc == null) continue;
    if (preferIncoming || out[k] == null) out[k] = inc;
  }
  for (const k of DATES) {
    const inc = incoming[k];
    if (!inc) continue;
    // Earliest response wins; latest email wins.
    if (!out[k]) out[k] = inc;
    else if (k === 'lastEmailAt') out[k] = new Date(inc) > new Date(out[k]) ? inc : out[k];
    else out[k] = new Date(inc) < new Date(out[k]) ? inc : out[k];
  }

  if (incoming.appliedAt && (preferIncoming || !out.appliedAt)) out.appliedAt = incoming.appliedAt;
  if (incoming.gotInterview) out.gotInterview = true;
  if (incoming.status) out.status = mergeStatus(out.status, incoming.status, preferIncoming);
  if (incoming.source === 'manual') out.source = 'manual';
  if (incoming.evidence) out.evidence = incoming.evidence;
  if (incoming.emailIds && incoming.emailIds.length) {
    out.emailIds = Array.from(new Set([...(out.emailIds || []), ...incoming.emailIds])).slice(-50);
  }
  if (incoming.rowIndex) out.rowIndex = incoming.rowIndex;
  return out;
}

/**
 * Status only advances. A manual edit (preferIncoming) can move it anywhere;
 * automated Gmail updates cannot walk it backwards, so a rejection never gets
 * overwritten by a later "thanks for applying" autoresponder.
 */
export function mergeStatus(current, next, force) {
  if (!current) return next;
  if (!next) return current;
  if (force) return next;
  const rc = C.STATUS_RANK[current] ?? 0;
  const rn = C.STATUS_RANK[next] ?? 0;
  // Ghosted is a soft state: any real signal replaces it.
  if (current === C.STATUS.GHOSTED && next !== C.STATUS.APPLIED) return next;
  return rn > rc ? next : current;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
}

export async function deleteApp(id) {
  const apps = await getApps();
  delete apps[id];
  await putApps(apps);
}

export async function markClean(ids, rowIndexes) {
  const apps = await getApps();
  ids.forEach((id, i) => {
    if (!apps[id]) return;
    apps[id].dirty = false;
    if (rowIndexes && rowIndexes[i]) apps[id].rowIndex = rowIndexes[i];
  });
  await putApps(apps);
}

// ---------------------------------------------------------------------------
// Resume aliases
// ---------------------------------------------------------------------------
/** Map an uploaded filename onto the friendly version label set in Options. */
export function resumeLabelFor(filename, aliases) {
  if (!filename) return '';
  const f = filename.toLowerCase();
  for (const a of aliases || []) {
    const m = (a.match || '').toLowerCase().trim();
    if (!m) continue;
    if (f === m || f.includes(m)) return a.label;
    try { if (new RegExp(m, 'i').test(filename)) return a.label; } catch (_) {}
  }
  // Fall back to the filename minus extension and timestamp noise.
  return U.clean(filename.replace(/\.[a-z]+$/i, '').replace(/[_-]?\d{6,}/g, '')).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Pending queue (used when "confirm before logging" is on)
// ---------------------------------------------------------------------------
export async function getPending() {
  const { pending } = await chrome.storage.local.get('pending');
  return pending || [];
}
export async function pushPending(rec) {
  const pending = await getPending();
  pending.unshift({ ...rec, pendingId: 'p_' + Date.now().toString(36) });
  await chrome.storage.local.set({ pending: pending.slice(0, 25) });
}
export async function dropPending(pendingId) {
  const pending = (await getPending()).filter((p) => p.pendingId !== pendingId);
  await chrome.storage.local.set({ pending });
}

// ---------------------------------------------------------------------------
// Job pages seen per tab, so an apply iframe can inherit the JD's metadata
// ---------------------------------------------------------------------------
// Held in chrome.storage.session rather than a Map: an MV3 service worker is
// torn down after ~30s idle, and filling in a form takes far longer than that,
// so an in-memory cache was routinely empty by the time the application landed.
const SEEN_KEY = 'seenByTab';

export async function rememberSeen(tabId, rec) {
  if (tabId == null) return;
  const { [SEEN_KEY]: map } = await chrome.storage.session.get(SEEN_KEY);
  const seen = map || {};
  seen[tabId] = { rec, at: Date.now() };
  const entries = Object.entries(seen).sort((a, b) => b[1].at - a[1].at).slice(0, 60);
  await chrome.storage.session.set({ [SEEN_KEY]: Object.fromEntries(entries) });
}

export async function recallSeen(tabId, maxAgeMs = 30 * 60_000) {
  if (tabId == null) return null;
  const { [SEEN_KEY]: map } = await chrome.storage.session.get(SEEN_KEY);
  const hit = map && map[tabId];
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.rec;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------
function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }

function median(nums) {
  const a = nums.filter((n) => typeof n === 'number' && isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

function bucket(list, keyFn, isInterview) {
  const map = new Map();
  for (const app of list) {
    const key = keyFn(app) || '—';
    const row = map.get(key) || { key, applied: 0, responded: 0, interviews: 0, offers: 0, rejected: 0 };
    row.applied++;
    if (app.firstResponseAt) row.responded++;
    if (isInterview(app)) row.interviews++;
    if (app.status === C.STATUS.OFFER) row.offers++;
    if (app.status === C.STATUS.REJECTED) row.rejected++;
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, responseRate: pct(r.responded, r.applied), interviewRate: pct(r.interviews, r.applied) }))
    .sort((a, b) => b.applied - a.applied);
}

/** Everything the popup dashboard and the Dashboard sheet tab render from. */
export function computeStats(list, settings = {}) {
  const apps = list.filter(Boolean);
  const isInterview = (a) => a.gotInterview || C.INTERVIEW_STATUSES.has(a.status);

  const total = apps.length;
  const responded = apps.filter((a) => !!a.firstResponseAt).length;
  const interviews = apps.filter(isInterview).length;
  const offers = apps.filter((a) => a.status === C.STATUS.OFFER).length;
  const rejected = apps.filter((a) => a.status === C.STATUS.REJECTED).length;
  const ghosted = apps.filter((a) => a.status === C.STATUS.GHOSTED).length;
  const awaiting = apps.filter((a) => a.status === C.STATUS.APPLIED && !a.firstResponseAt).length;

  const responseDays = apps
    .filter((a) => a.firstResponseAt && a.appliedAt)
    .map((a) => Number(U.daysBetween(a.appliedAt, a.firstResponseAt)))
    .filter((n) => isFinite(n));
  const inviteDays = apps
    .filter((a) => a.interviewInviteAt && a.appliedAt)
    .map((a) => Number(U.daysBetween(a.appliedAt, a.interviewInviteAt)))
    .filter((n) => isFinite(n));

  const withComp = apps.filter((a) => a.salaryMin || a.salaryMax);
  const midpoints = withComp.map((a) => {
    const lo = a.salaryMin || a.salaryMax;
    const hi = a.salaryMax || a.salaryMin;
    return Math.round((lo + hi) / 2);
  });

  const weekKey = (a) => {
    const d = new Date(a.appliedAt);
    if (isNaN(d)) return '';
    const day = (d.getDay() + 6) % 7;          // Monday-start
    d.setDate(d.getDate() - day);
    return U.isoDate(d);
  };

  return {
    total,
    responded,
    interviews,
    offers,
    rejected,
    ghosted,
    awaiting,
    responseRate: pct(responded, total),
    interviewRate: pct(interviews, total),
    offerRate: pct(offers, total),
    interviewsPerResponse: pct(interviews, responded),
    medianDaysToResponse: median(responseDays),
    medianDaysToInterview: median(inviteDays),
    medianCompMidpoint: median(midpoints),
    compCoverage: pct(withComp.length, total),
    byResume: bucket(apps, (a) => a.resumeLabel || a.resumeName, isInterview),
    byWorkMode: bucket(apps, (a) => a.workMode, isInterview),
    byStage: bucket(apps, (a) => a.companyStage, isInterview),
    byBoard: bucket(apps, (a) => a.board, isInterview),
    byStatus: bucket(apps, (a) => a.status, isInterview),
    byWeek: bucket(apps, weekKey, isInterview).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 26),
    generatedAt: new Date().toISOString(),
    ghostAfterDays: settings.ghostAfterDays || C.GHOST_AFTER_DAYS,
  };
}
