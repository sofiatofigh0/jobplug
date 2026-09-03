import '../common/constants.js';
import '../common/util.js';
import {
  getSettings, setSettings, getAppList, getApps, upsertApp, markClean,
  resumeLabelFor, computeStats, recallSeen, pushPending,
} from './store.js';
import { pushApps, writeDashboard, appendEvents, pullEdits, ensureSpreadsheet } from './sheets.js';
import { scanForReplies } from './gmail.js';
import { enrichCompany } from './enrich.js';

const { C, U } = globalThis.JAT;

let pushTimer = null;
let syncing = false;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Handle a detection from a content script.
 * The apply page is usually thinner than the job description (and is often an
 * iframe), so we merge in whatever the JD page reported for the same tab.
 */
export async function captureApplication(record, sender) {
  const settings = await getSettings();
  if (!settings.autoCapture) return { ok: false, reason: 'capture disabled' };

  const host = U.hostOf(record.jdUrl || record.frameUrl || '');
  if ((settings.excludeHosts || []).some((h) => host === h || host.endsWith('.' + h))) {
    return { ok: false, reason: 'host excluded' };
  }

  const tabId = sender && sender.tab && sender.tab.id;
  const seen = await recallSeen(tabId);
  const merged = mergeSeen(seen, record);

  if (!merged.company && !merged.position) return { ok: false, reason: 'no identifying metadata' };
  merged.resumeLabel = resumeLabelFor(merged.resumeName, settings.resumeAliases);

  if (settings.confirmBeforeLogging) {
    await pushPending(merged);
    await refreshBadge();
    notify('Confirm this application', `${merged.position || 'Role'} @ ${merged.company || 'company'} — open JobPlug to confirm.`);
    return { ok: true, pending: true };
  }

  const { app, created } = await upsertApp(merged);
  await flashBadge(created ? '+1' : '↻');
  enrichIfThin(app, settings);
  if (settings.notifications) {
    notify(
      created ? 'Application tracked' : 'Application updated',
      [app.position, app.company].filter(Boolean).join(' @ ') +
        (app.resumeLabel ? ` · ${app.resumeLabel}` : '')
    );
  }
  schedulePush();
  return { ok: true, id: app.id, created };
}

/** JD-page metadata fills gaps; the capture's own values always win. */
function mergeSeen(seen, record) {
  if (!seen) return record;
  const out = { ...seen };
  for (const [k, v] of Object.entries(record)) {
    if (v !== '' && v !== null && v !== undefined) out[k] = v;
  }
  // A capture inside an iframe has the iframe URL; prefer the real posting.
  if (record.isFrame && seen.jdUrl) out.jdUrl = seen.jdUrl;
  return out;
}

/**
 * Fill in funding data the job page didn't state, if an enrichment provider is
 * configured. Fire-and-forget: capture must never wait on a third party.
 */
function enrichIfThin(app, settings) {
  if (!settings.enrichEnabled) return;
  if (app.companyStage && app.totalRaised && app.headcount) return;
  enrichCompany({ company: app.company, domain: app.companyDomain }, settings)
    .then(async (extra) => {
      if (!Object.keys(extra).length) return;
      await upsertApp({ id: app.id, ...extra });
      schedulePush(1500);
    })
    .catch(() => {});
}

function schedulePush(delay = 4000) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { syncNow({ silent: true }).catch(() => {}); }, delay);
}

// ---------------------------------------------------------------------------
// Sheet sync
// ---------------------------------------------------------------------------

/**
 * Reconcile local state with the spreadsheet:
 *   1. pull manual edits made in Sheets
 *   2. age out silent applications
 *   3. push everything dirty
 *   4. rewrite the dashboard
 */
export async function syncNow({ silent = false, force = false } = {}) {
  if (syncing) return { ok: false, reason: 'already syncing' };
  syncing = true;
  try {
    const settings = await getSettings();
    await ensureSpreadsheet();

    await applySheetEdits();
    const aged = await markGhosted(settings);

    const all = await getAppList();
    const dirty = force ? all : all.filter((a) => a.dirty);

    let pushed = { updated: 0, appended: 0, rowIndexes: {} };
    if (dirty.length) {
      pushed = await pushApps(dirty);
      await markClean(dirty.map((a) => a.id), dirty.map((a) => pushed.rowIndexes[a.id]));
      await stampSyncedStatus(dirty);
    }

    const stats = computeStats(await getAppList(), settings);
    await writeDashboard(stats);
    await setSettings({ lastSheetSync: Date.now() });
    await refreshBadge();

    return { ok: true, pushed: dirty.length, updated: pushed.updated, appended: pushed.appended, ghosted: aged, stats };
  } catch (err) {
    if (!silent) console.error('[JobPlug] sync failed', err);
    return { ok: false, error: err.message, needsAuth: err.status === 401 || !!err.needsAuth };
  } finally {
    syncing = false;
  }
}

/**
 * Bring edits made directly in Google Sheets back into local state.
 *
 * Status is special: it only advances automatically, but if the value in the
 * sheet differs from what we last wrote there, the user changed it by hand and
 * their choice wins outright — including moving a row backwards.
 */
async function applySheetEdits() {
  let rows = [];
  try { rows = await pullEdits(); } catch { return 0; }
  if (!rows.length) return 0;

  const apps = await getApps();
  let changed = 0;

  for (const row of rows) {
    const app = apps[row.id];
    if (!app) continue;

    const patch = { id: row.id };
    for (const k of ['notes', 'resumeLabel', 'companyStage', 'headcount', 'workMode']) {
      if (row[k] && row[k] !== app[k]) patch[k] = row[k];
    }
    for (const k of ['valuation', 'totalRaised']) {
      const v = row[k] === '' || row[k] == null ? null : Number(row[k]);
      if (v != null && isFinite(v) && v !== app[k]) patch[k] = v;
    }

    const userEditedStatus = row.status && row.status !== (app.syncedStatus || '') && row.status !== app.status;
    if (userEditedStatus) patch.status = row.status;

    if (Object.keys(patch).length > 1) {
      await upsertApp(patch, { preferIncoming: true });
      changed++;
    }
  }
  return changed;
}

async function stampSyncedStatus(list) {
  const apps = await getApps();
  for (const a of list) if (apps[a.id]) apps[a.id].syncedStatus = apps[a.id].status;
  await chrome.storage.local.set({ apps });
}

/** Applications with no reply after the configured window are marked Ghosted. */
export async function markGhosted(settings) {
  const days = settings.ghostAfterDays || C.GHOST_AFTER_DAYS;
  const cutoff = Date.now() - days * 86400000;
  const apps = await getApps();
  let n = 0;
  for (const app of Object.values(apps)) {
    if (app.status !== C.STATUS.APPLIED || app.firstResponseAt) continue;
    const t = new Date(app.appliedAt).getTime();
    if (isFinite(t) && t < cutoff) {
      app.status = C.STATUS.GHOSTED;
      app.dirty = true;
      app.updatedAt = new Date().toISOString();
      n++;
    }
  }
  if (n) await chrome.storage.local.set({ apps });
  return n;
}

// ---------------------------------------------------------------------------
// Gmail sync
// ---------------------------------------------------------------------------
export async function gmailSync({ silent = false } = {}) {
  const settings = await getSettings();
  if (!settings.gmailEnabled) return { ok: false, reason: 'gmail disabled' };

  try {
    const apps = await getAppList();
    if (!apps.length) return { ok: true, updates: 0, considered: 0 };

    const { updates, events, considered } = await scanForReplies(apps, settings);

    let invites = 0;
    for (const patch of updates) {
      if (patch.gotInterview) invites++;
      await upsertApp(patch);
    }

    if (events.length) {
      try { await appendEvents(events); } catch (err) { console.warn('[JobPlug] event log failed', err.message); }
    }

    await setSettings({ lastGmailSync: Date.now() });

    if (invites && settings.notifications) {
      const names = updates.filter((u) => u.gotInterview).map((u) => (apps.find((a) => a.id === u.id) || {}).company).filter(Boolean);
      notify(
        invites === 1 ? 'Interview invite detected' : `${invites} interview invites detected`,
        names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '')
      );
    }

    if (updates.length) await syncNow({ silent: true });
    return { ok: true, updates: updates.length, invites, considered, events: events.length };
  } catch (err) {
    if (!silent) console.error('[JobPlug] gmail sync failed', err);
    return { ok: false, error: err.message, needsAuth: err.status === 401 || !!err.needsAuth };
  }
}

// ---------------------------------------------------------------------------
// Badge + notifications
// ---------------------------------------------------------------------------
export async function refreshBadge() {
  const { pending } = await chrome.storage.local.get('pending');
  const n = (pending || []).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: n ? '#d97706' : '#2563eb' });
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  } catch (_) {}
}

let flashTimer = null;
async function flashBadge(text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    await chrome.action.setBadgeText({ text });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { refreshBadge().catch(() => {}); }, 6000);
  } catch (_) {}
}

export function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message || '').slice(0, 220),
      priority: 0,
    }, () => void chrome.runtime.lastError);
  } catch (_) {}
}
