import '../common/constants.js';
import '../common/util.js';
import { signIn, signOut, authState, explainAuthError } from './auth.js';
import {
  getSettings, setSettings, getAppList, getApp, upsertApp, deleteApp,
  computeStats, rememberSeen, getPending, dropPending, resumeLabelFor, makeId,
} from './store.js';
import { ensureSpreadsheet } from './sheets.js';
import { gmailProfile } from './gmail.js';
import { captureApplication, syncNow, gmailSync, refreshBadge, notify } from './sync.js';

const { C, U } = globalThis.JAT;

const ALARM_GMAIL = 'jat-gmail';
const ALARM_SHEET = 'jat-sheet';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  await setSettings({});                 // materialise defaults
  await scheduleAlarms();
  await refreshBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await refreshBadge();
});

async function scheduleAlarms() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_GMAIL);
  await chrome.alarms.clear(ALARM_SHEET);
  chrome.alarms.create(ALARM_GMAIL, { periodInMinutes: Math.max(5, s.gmailPollMinutes || 30), delayInMinutes: 1 });
  chrome.alarms.create(ALARM_SHEET, { periodInMinutes: 60, delayInMinutes: 3 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const s = await getSettings();
  if (!s.spreadsheetId && !(await authState()).connected) return;
  if (alarm.name === ALARM_GMAIL) await gmailSync({ silent: true });
  if (alarm.name === ALARM_SHEET) await syncNow({ silent: true });
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
const handlers = {
  async GET_STATE() {
    const [settings, apps, auth, pending] = await Promise.all([
      getSettings(), getAppList(), authState(), getPending(),
    ]);
    return {
      settings,
      auth,
      pending,
      apps: apps.slice(0, 200),
      stats: computeStats(apps, settings),
    };
  },

  async SIGN_IN() {
    const settings = await getSettings();
    let profile;
    try {
      profile = await signIn();
    } catch (err) {
      // Chrome's OAuth errors name the symptom, never the fix. Attach one.
      throw Object.assign(err, { explain: explainAuthError(err, settings.authMode) });
    }
    const id = await ensureSpreadsheet();
    return { profile, spreadsheetId: id, spreadsheetUrl: (await getSettings()).spreadsheetUrl };
  },

  async DIAGNOSTICS() {
    const manifest = chrome.runtime.getManifest();
    return {
      extensionId: chrome.runtime.id,
      redirectUri: chrome.identity.getRedirectURL(),
      manifestClientId: (manifest.oauth2 && manifest.oauth2.client_id) || '',
      hasPinnedKey: !!manifest.key,
    };
  },

  async SIGN_OUT() {
    await signOut();
    return { ok: true };
  },

  async CHECK_GMAIL_ACCESS() {
    const p = await gmailProfile();
    return { ok: true, email: p.emailAddress, messagesTotal: p.messagesTotal };
  },

  async SET_SETTINGS({ patch }) {
    const next = await setSettings(patch);
    if ('gmailPollMinutes' in patch) await scheduleAlarms();
    return next;
  },

  async CAPTURE({ record, evidence }, sender) {
    return captureApplication({ ...record, evidence }, sender);
  },

  async DETECT_LOG({ entry }, sender) {
    const { detectLog } = await chrome.storage.local.get('detectLog');
    const log = detectLog || [];
    log.unshift({ ...entry, tabUrl: (sender && sender.tab && sender.tab.url) || entry.url });
    await chrome.storage.local.set({ detectLog: log.slice(0, 50) });
    return { ok: true };
  },

  async GET_DETECT_LOG() {
    const { detectLog } = await chrome.storage.local.get('detectLog');
    return { log: detectLog || [] };
  },

  async CLEAR_DETECT_LOG() {
    await chrome.storage.local.remove('detectLog');
    return { ok: true };
  },

  async SEEN_JOB({ record }, sender) {
    await rememberSeen(sender && sender.tab && sender.tab.id, record);
    return { ok: true };
  },

  async ADD_MANUAL({ record }) {
    const settings = await getSettings();
    const rec = {
      ...record,
      source: 'manual',
      appliedAt: record.appliedAt || new Date().toISOString(),
      resumeLabel: record.resumeLabel || resumeLabelFor(record.resumeName, settings.resumeAliases),
    };
    const { app, created } = await upsertApp(rec, { preferIncoming: true });
    await syncNow({ silent: true });
    return { app, created };
  },

  async UPDATE_APP({ id, patch }) {
    const existing = await getApp(id);
    if (!existing) throw new Error('Application not found');
    const { app } = await upsertApp({ ...patch, id }, { preferIncoming: true });
    await syncNow({ silent: true });
    return { app };
  },

  async DELETE_APP({ id }) {
    await deleteApp(id);
    await syncNow({ silent: true, force: true });
    return { ok: true };
  },

  async CONFIRM_PENDING({ pendingId, overrides }) {
    const pending = await getPending();
    const rec = pending.find((p) => p.pendingId === pendingId);
    if (!rec) throw new Error('That capture is no longer pending');
    delete rec.pendingId;
    const { app, created } = await upsertApp({ ...rec, ...(overrides || {}) }, { preferIncoming: true });
    await dropPending(pendingId);
    await refreshBadge();
    await syncNow({ silent: true });
    return { app, created };
  },

  async DISCARD_PENDING({ pendingId }) {
    await dropPending(pendingId);
    await refreshBadge();
    return { ok: true };
  },

  async SYNC_NOW() {
    return syncNow({ force: true });
  },

  async GMAIL_SYNC() {
    return gmailSync({});
  },

  async OPEN_SHEET() {
    const s = await getSettings();
    const url = s.spreadsheetUrl || (s.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}` : null);
    if (!url) throw new Error('No spreadsheet yet — connect Google first.');
    await chrome.tabs.create({ url });
    return { ok: true };
  },

  /**
   * Probe every open web tab, not just the active one.
   *
   * The self-test is triggered from the options page, which is by definition
   * the active tab at the moment the button is pressed — so querying the
   * active tab only ever probed the options page itself.
   */
  async PING_TABS() {
    const tabs = await chrome.tabs.query({});
    const web = tabs
      .filter((t) => t.id && /^https?:/i.test(t.url || ''))
      .slice(0, 25);

    if (!web.length) {
      return { tabs: [], note: 'No ordinary web pages are open. Open a job posting in a tab, then run this again.' };
    }

    const results = await Promise.all(web.map(async (t) => {
      const res = await chrome.tabs.sendMessage(t.id, { type: 'PING' }).catch(() => null);
      return {
        title: (t.title || '').slice(0, 70),
        url: t.url,
        host: U.hostOf(t.url),
        alive: !!(res && res.alive),
        board: (res && res.board) || '',
        onAtsHost: !!(res && res.onAtsHost),
        score: res ? res.score : null,
        threshold: res ? res.threshold : null,
        reasons: (res && res.reasons) || [],
        resume: (res && res.resume) || '',
      };
    }));

    const alive = results.filter((r) => r.alive).length;
    return {
      tabs: results,
      alive,
      total: results.length,
      note: alive === 0
        ? 'The content script is running in none of your open tabs. Every one of them was loaded before the extension was last reloaded — reload a job page (Cmd-R) and run this again.'
        : '',
    };
  },

  /** Ask the active tab what job it is showing, for one-click manual add. */
  async SCRAPE_ACTIVE_TAB() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_CURRENT' }).catch(() => null);
    if (res && res.ok) return { record: res.record, tabUrl: tab.url, tabTitle: tab.title };
    // Content script not present (chrome:// page, PDF viewer, or a fresh install).
    return { record: { jdUrl: tab.url || '', position: U.clean(tab.title || '') }, tabUrl: tab.url, tabTitle: tab.title };
  },

  async EXPORT_CSV() {
    const apps = await getAppList();
    const rows = [C.HEADERS];
    for (const a of apps) {
      rows.push(C.COLUMNS.map((col) => {
        switch (col.key) {
          case 'appliedAt': return U.isoDate(a.appliedAt);
          case 'firstResponseAt': return U.isoDate(a.firstResponseAt);
          case 'interviewInviteAt': return U.isoDate(a.interviewInviteAt);
          case 'lastEmailAt': return U.isoDate(a.lastEmailAt);
          case 'updatedAt': return U.isoDateTime(a.updatedAt);
          case 'gotInterview': return a.gotInterview ? 'Yes' : 'No';
          case 'threadUrl': return a.threadId ? `https://mail.google.com/mail/u/0/#all/${a.threadId}` : '';
          case 'daysToResponse': return a.firstResponseAt ? U.daysBetween(a.appliedAt, a.firstResponseAt) : '';
          default: return a[col.key] == null ? '' : a[col.key];
        }
      }));
    }
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    return { csv, filename: `job-applications-${U.isoDate(new Date())}.csv` };
  },

  async PREVIEW_ID({ record }) {
    return { id: makeId(record) };
  },
};

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const handler = handlers[msg.type];
  if (!handler) return false;

  Promise.resolve(handler(msg.payload || {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({
      ok: false,
      error: err && err.message ? err.message : String(err),
      explain: (err && err.explain) || null,
      needsAuth: !!(err && (err.needsAuth || err.status === 401)),
    }));
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Right-click: track a job page the detector missed
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'jat-track-page',
      title: 'Track this job application',
      contexts: ['page', 'link'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'jat-track-page' || !tab || !tab.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_CURRENT' }).catch(() => null);
    const record = (res && res.ok && res.record) || { jdUrl: info.linkUrl || tab.url, position: tab.title };
    const settings = await getSettings();
    const { app, created } = await upsertApp(
      { ...record, source: 'manual', resumeLabel: resumeLabelFor(record.resumeName, settings.resumeAliases) },
      { preferIncoming: true }
    );
    notify(created ? 'Application tracked' : 'Application updated', [app.position, app.company].filter(Boolean).join(' @ '));
    await syncNow({ silent: true });
  } catch (err) {
    notify('Could not track this page', err.message);
  }
});
