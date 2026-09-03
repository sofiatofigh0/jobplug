import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { C, U, resetStorage, rawStorage } from './helpers.mjs';

const SHEET_ID = 'sheet-123';

/** Every request the code makes, so tests can assert on shapes. */
let calls = [];

function json(body) {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
  };
}

async function defaultFetch(url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, method, body });

  if (url.includes(':append')) return json({ updates: { updatedRange: 'Applications!A5:AG6' } });
  if (url.includes(':clear')) return json({});
  if (url.includes(':batchUpdate')) return json({ replies: [] });
  if (url.includes('conditionalFormats')) return json({ sheets: [{ properties: { sheetId: 0 }, conditionalFormats: [{}, {}] }] });
  if (url.includes('fields=sheets.properties')) {
    return json({ sheets: [C.TAB_APPLICATIONS, C.TAB_DASHBOARD, C.TAB_EVENTS].map((title, i) => ({ properties: { title, sheetId: i } })) });
  }
  if (url.includes('fields=spreadsheetId')) return json({ spreadsheetId: SHEET_ID });
  if (url.includes('/values/') && method === 'GET') return json({ values: [] });
  return json({});
}

globalThis.fetch = defaultFetch;
const Sheets = await import('../extension/src/background/sheets.js');

const app = {
  id: 'a_test1',
  appliedAt: '2026-08-01T12:00:00.000Z',
  company: 'Acme Robotics',
  position: 'Senior Platform Engineer',
  jdUrl: 'https://boards.greenhouse.io/acme/jobs/42?src="x"',
  board: 'Greenhouse',
  location: 'New York, NY',
  workMode: 'Remote',
  salaryMin: 180000, salaryMax: 220000, salaryRaw: '$180,000 – $220,000',
  resumeName: 'sofia_backend_v3.pdf',
  companyStage: 'Series B', valuation: 500000000, totalRaised: 50000000,
  headcount: '120', companyDomain: 'acme.com',
  status: C.STATUS.INTERVIEW, gotInterview: true,
  firstResponseAt: '2026-08-06T09:00:00.000Z',
  interviewInviteAt: '2026-08-06T09:00:00.000Z',
  threadId: 'thread-abc',
  notes: 'Referred by Dana',
  source: 'auto',
  updatedAt: '2026-08-06T10:00:00.000Z',
};

beforeEach(() => {
  calls = [];
  // Tests that install their own mock must not leak it into the next test.
  globalThis.fetch = defaultFetch;
  resetStorage();
  rawStorage.settings = {
    authMode: 'chrome',
    spreadsheetId: SHEET_ID,
    sheetFormattedVersion: C.SCHEMA_VERSION,
    resumeAliases: [{ match: 'backend_v3', label: 'Backend v3' }],
  };
});

test('new applications go through the append endpoint', async () => {
  await Sheets.pushApps([app]);
  const append = calls.find((c) => c.url.includes(':append'));
  assert.ok(append, 'must call values:append, not the plain values endpoint');
  assert.equal(append.method, 'POST');
  assert.match(append.url, /valueInputOption=USER_ENTERED/);
  assert.match(append.url, /insertDataOption=INSERT_ROWS/);
});

test('a row matches the column schema exactly', async () => {
  await Sheets.pushApps([app]);
  const row = calls.find((c) => c.url.includes(':append')).body.values[0];
  assert.equal(row.length, C.COLUMNS.length, 'row width must equal the header width');

  const at = (key) => row[C.COL_INDEX[key]];
  assert.equal(at('id'), 'a_test1');
  assert.equal(at('appliedAt'), '2026-08-01');
  assert.equal(at('company'), 'Acme Robotics');
  assert.equal(at('workMode'), 'Remote');
  assert.equal(at('salaryMin'), 180000);
  assert.equal(at('gotInterview'), 'Yes');
  assert.equal(at('status'), C.STATUS.INTERVIEW);
  assert.equal(at('resumeLabel'), 'Backend v3', 'resume alias must be applied on write');
});

test('URLs are written as hyperlinks with quotes neutralised', async () => {
  await Sheets.pushApps([app]);
  const row = calls.find((c) => c.url.includes(':append')).body.values[0];
  const cell = row[C.COL_INDEX.jdUrl];
  assert.match(cell, /^=HYPERLINK\("https:\/\/boards\.greenhouse\.io/);
  assert.equal((cell.match(/"/g) || []).length, 4, 'a stray quote in the URL would break the formula');
  assert.match(row[C.COL_INDEX.threadUrl], /^=HYPERLINK\("https:\/\/mail\.google\.com/);
});

test('days-to-response is a position-independent formula', async () => {
  await Sheets.pushApps([app]);
  const row = calls.find((c) => c.url.includes(':append')).body.values[0];
  const f = row[C.COL_INDEX.daysToResponse];
  assert.match(f, /^=IFERROR\(/);
  assert.match(f, /ROW\(\)/, 'must resolve its own row, since append picks where the row lands');
  assert.ok(!/\$[A-Z]+\d/.test(f), 'must not hard-code a row number');
});

test('existing rows are updated in place, not appended', async () => {
  globalThis.fetch = (async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('/values/') && method === 'GET') return json({ values: [['a_test1']] });
    if (url.includes('fields=sheets.properties')) return json({ sheets: [{ properties: { title: C.TAB_APPLICATIONS, sheetId: 0 } }, { properties: { title: C.TAB_DASHBOARD, sheetId: 1 } }, { properties: { title: C.TAB_EVENTS, sheetId: 2 } }] });
    if (url.includes('fields=spreadsheetId')) return json({ spreadsheetId: SHEET_ID });
    return json({});
  });

  const res = await Sheets.pushApps([app]);
  assert.equal(res.updated, 1);
  assert.equal(res.appended, 0);
  assert.equal(res.rowIndexes.a_test1, 2, 'the first data row is row 2');
  assert.ok(!calls.some((c) => c.url.includes(':append')), 'a known App ID must not be appended again');

  const update = calls.find((c) => c.url.includes('values:batchUpdate'));
  assert.match(update.body.data[0].range, /^Applications!A2:[A-Z]+2$/);
});

test('the dashboard rate formulas divide by the total row', async () => {
  const stats = { total: 4, awaiting: 1, ghosted: 0, medianDaysToResponse: 5, medianDaysToInterview: 4,
    medianCompMidpoint: 200000, compCoverage: 75, ghostAfterDays: 21,
    byResume: [{ key: 'Backend v3', applied: 3, responded: 3, interviews: 2, responseRate: 100, interviewRate: 66.7 }],
    byWorkMode: [], byStage: [], byBoard: [], byWeek: [] };

  await Sheets.writeDashboard(stats);
  const write = calls.find((c) => c.method === 'PUT' && c.url.includes('Dashboard'));
  const rows = write.body.values;

  // Row 5 (index 4) holds the total; every rate divides by it.
  assert.match(String(rows[4][1]), /^=SUMPRODUCT/, 'row 5 must be the total');
  assert.equal(rows[5][2], '=IFERROR(B6/B5,"")');
  assert.equal(rows[6][2], '=IFERROR(B7/B5,"")');
  assert.equal(rows[9][2], '=IFERROR(B10/B5,"")');
});

test('the email log appends rather than overwriting', async () => {
  await Sheets.appendEvents([{
    receivedAt: '2026-08-06T09:00:00.000Z', company: 'Acme', position: 'Engineer',
    from: 'recruiting@acme.com', subject: 'Next steps', classification: 'INTERVIEW_INVITE',
    confidence: 0.9, threadId: 'thread-abc',
  }]);
  const append = calls.find((c) => c.url.includes(':append') && c.url.includes(encodeURIComponent(C.TAB_EVENTS)));
  assert.ok(append, 'Email Log must use values:append');
  assert.equal(append.body.values[0].length, 8);
});

test('stale conditional-format rules are cleared before new ones are added', async () => {
  rawStorage.settings.sheetFormattedVersion = 0;   // force a reformat
  await Sheets.pushApps([app]);
  const deletes = calls
    .filter((c) => c.body && Array.isArray(c.body.requests))
    .flatMap((c) => c.body.requests)
    .filter((r) => r.deleteConditionalFormatRule);
  assert.equal(deletes.length, 2, 'both existing rules must be removed');
  assert.deepEqual(deletes.map((d) => d.deleteConditionalFormatRule.index), [1, 0],
    'rules must be deleted from the end, since removal renumbers the rest');
});
