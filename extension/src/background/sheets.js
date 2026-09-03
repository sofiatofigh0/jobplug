import '../common/constants.js';
import '../common/util.js';
import { api } from './auth.js';
import { getSettings, setSettings, resumeLabelFor } from './store.js';

const { C, U } = globalThis.JAT;

const L = (key) => U.colLetter(C.COL_INDEX[key]);
const LAST_COL = U.colLetter(C.COLUMNS.length - 1);

// ---------------------------------------------------------------------------
// Spreadsheet bootstrap
// ---------------------------------------------------------------------------

/** Map tab title -> sheetId for an existing spreadsheet. */
async function sheetIds(spreadsheetId) {
  const meta = await api(`${C.SHEETS_API}/${spreadsheetId}?fields=sheets.properties`);
  const map = {};
  for (const s of meta.sheets || []) map[s.properties.title] = s.properties.sheetId;
  return map;
}

async function batchUpdate(spreadsheetId, requests) {
  if (!requests.length) return null;
  return api(`${C.SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

// One sync calls ensureSpreadsheet several times (rows, events, dashboard).
// Verify the sheet once per worker lifetime rather than once per write.
let verifiedId = '';

/** Create the tracker spreadsheet, or adopt/repair one that already exists. */
export async function ensureSpreadsheet() {
  const settings = await getSettings();
  if (settings.spreadsheetId) {
    // The memo skips re-verifying the sheet exists, but never skips a pending
    // reformat — otherwise a schema bump would not land until the worker died.
    if (verifiedId === settings.spreadsheetId && settings.sheetFormattedVersion === C.SCHEMA_VERSION) {
      return verifiedId;
    }
    try {
      await api(`${C.SHEETS_API}/${settings.spreadsheetId}?fields=spreadsheetId`);
      await ensureTabs(settings.spreadsheetId);
      verifiedId = settings.spreadsheetId;
      return settings.spreadsheetId;
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      verifiedId = '';
      // The sheet was deleted or unshared — fall through and make a fresh one.
    }
  }

  const created = await api(C.SHEETS_API, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: `Job Applications — ${C.EXT_NAME}`, locale: 'en_US' },
      sheets: [
        { properties: { title: C.TAB_APPLICATIONS, gridProperties: { frozenRowCount: 1, columnCount: C.COLUMNS.length } } },
        { properties: { title: C.TAB_DASHBOARD } },
        { properties: { title: C.TAB_EVENTS, gridProperties: { frozenRowCount: 1 } } },
      ],
    }),
  });

  const id = created.spreadsheetId;
  await setSettings({
    spreadsheetId: id,
    spreadsheetUrl: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}`,
    sheetFormattedVersion: 0,
  });
  await ensureTabs(id, { reformat: true });
  verifiedId = id;
  return id;
}

/** Make sure all three tabs exist, are formatted, and carry the right headers. */
async function ensureTabs(spreadsheetId, { reformat = false } = {}) {
  let ids = await sheetIds(spreadsheetId);

  const missing = [C.TAB_APPLICATIONS, C.TAB_DASHBOARD, C.TAB_EVENTS].filter((t) => ids[t] === undefined);
  if (missing.length) {
    await batchUpdate(spreadsheetId, missing.map((title) => ({ addSheet: { properties: { title } } })));
    ids = await sheetIds(spreadsheetId);
  }

  await writeValues(spreadsheetId, `${C.TAB_APPLICATIONS}!A1:${LAST_COL}1`, [C.HEADERS]);
  await writeValues(spreadsheetId, `${C.TAB_EVENTS}!A1:H1`, [[
    'Received', 'Company', 'Position', 'From', 'Subject', 'Classification', 'Confidence', 'Gmail Thread',
  ]]);

  const settings = await getSettings();
  if (reformat || settings.sheetFormattedVersion !== C.SCHEMA_VERSION) {
    await applyFormatting(spreadsheetId, ids);
    await setSettings({ sheetFormattedVersion: C.SCHEMA_VERSION });
  }
  return ids;
}

function currencyFormat() { return { type: 'CURRENCY', pattern: '"$"#,##0' }; }

/**
 * Conditional-format rules are additive in the API: re-running this blindly on
 * every sync would stack hundreds of identical rules onto the sheet. Clear the
 * ones we own first.
 */
async function clearConditionalFormats(spreadsheetId, sheetId) {
  const meta = await api(
    `${C.SHEETS_API}/${spreadsheetId}?fields=sheets(properties.sheetId,conditionalFormats)`
  );
  const sheet = (meta.sheets || []).find((x) => x.properties.sheetId === sheetId);
  const count = (sheet && sheet.conditionalFormats && sheet.conditionalFormats.length) || 0;
  if (!count) return;
  // Delete from the end: each removal renumbers the rules after it.
  const reqs = [];
  for (let i = count - 1; i >= 0; i--) reqs.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  await batchUpdate(spreadsheetId, reqs);
}

async function applyFormatting(spreadsheetId, ids) {
  const appsId = ids[C.TAB_APPLICATIONS];
  const eventsId = ids[C.TAB_EVENTS];
  const dashId = ids[C.TAB_DASHBOARD];
  const reqs = [];

  reqs.push({
    updateSheetProperties: {
      properties: { sheetId: appsId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 3 } },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  // Header row.
  for (const [sheetId, cols] of [[appsId, C.COLUMNS.length], [eventsId, 8]]) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.11, green: 0.15, blue: 0.22 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 10 },
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'CLIP',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)',
      },
    });
  }

  // Column widths + per-type number formats.
  C.COLUMNS.forEach((col, i) => {
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId: appsId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: col.width || 120 },
        fields: 'pixelSize',
      },
    });
    let numberFormat = null;
    if (col.type === 'MONEY') numberFormat = currencyFormat();
    else if (col.type === 'DATE') numberFormat = { type: 'DATE', pattern: 'yyyy-mm-dd' };
    else if (col.type === 'DATETIME') numberFormat = { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' };
    else if (col.type === 'NUMBER') numberFormat = { type: 'NUMBER', pattern: '0' };
    if (numberFormat) {
      reqs.push({
        repeatCell: {
          range: { sheetId: appsId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: { userEnteredFormat: { numberFormat } },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    }
    if (col.note) {
      reqs.push({
        updateCells: {
          range: { sheetId: appsId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          rows: [{ values: [{ note: col.note }] }],
          fields: 'note',
        },
      });
    }
  });

  reqs.push({
    setBasicFilter: {
      filter: { range: { sheetId: appsId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: C.COLUMNS.length } },
    },
  });

  // Status colour coding.
  const statusCol = C.COL_INDEX.status;
  const statusColors = [
    [C.STATUS.OFFER, { red: 0.78, green: 0.93, blue: 0.78 }],
    [C.STATUS.INTERVIEW, { red: 0.80, green: 0.89, blue: 0.99 }],
    [C.STATUS.ONSITE, { red: 0.80, green: 0.89, blue: 0.99 }],
    [C.STATUS.SCREEN, { red: 0.87, green: 0.93, blue: 1.00 }],
    [C.STATUS.REJECTED, { red: 0.98, green: 0.82, blue: 0.82 }],
    [C.STATUS.GHOSTED, { red: 0.93, green: 0.93, blue: 0.93 }],
    [C.STATUS.ACKNOWLEDGED, { red: 1.00, green: 0.95, blue: 0.80 }],
  ];
  statusColors.forEach(([value, color], idx) => {
    reqs.push({
      addConditionalFormatRule: {
        index: idx,
        rule: {
          ranges: [{ sheetId: appsId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: { backgroundColor: color },
          },
        },
      },
    });
  });

  // Highlight the whole row when an interview invite landed.
  reqs.push({
    addConditionalFormatRule: {
      index: statusColors.length,
      rule: {
        ranges: [{ sheetId: appsId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: C.COLUMNS.length }],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: `=$${L('gotInterview')}2="Yes"` }],
          },
          format: { textFormat: { bold: true } },
        },
      },
    },
  });

  // Dropdown for Status so manual edits stay in the vocabulary.
  reqs.push({
    setDataValidation: {
      range: { sheetId: appsId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: Object.values(C.STATUS).map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      },
    },
  });

  reqs.push({
    updateDimensionProperties: {
      range: { sheetId: dashId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 230 }, fields: 'pixelSize',
    },
  });

  try {
    await clearConditionalFormats(spreadsheetId, appsId);
    await batchUpdate(spreadsheetId, reqs);
  } catch (err) {
    // Formatting is cosmetic — never let it block a write. Conditional-format
    // rules in particular fail if they already exist from an earlier run.
    console.warn('[JobPlug] formatting skipped:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Values I/O
// ---------------------------------------------------------------------------
async function writeValues(spreadsheetId, range, values) {
  return api(
    `${C.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) }
  );
}

async function readValues(spreadsheetId, range) {
  const res = await api(
    `${C.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`
  );
  return res.values || [];
}

/** "Applications!A57:AG58" -> 57 */
function parseRangeStart(appendResponse) {
  const range = appendResponse && appendResponse.updates && appendResponse.updates.updatedRange;
  const m = range && String(range).match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

function hyperlink(url, label) {
  if (!url) return '';
  const safeUrl = String(url).replace(/"/g, '%22');
  const safeLabel = String(label || url).replace(/"/g, "'").slice(0, 90);
  return `=HYPERLINK("${safeUrl}","${safeLabel}")`;
}

/**
 * Live "days to response" formula.
 *
 * Written with INDEX(col, ROW()) rather than a plain A1 reference so it stays
 * correct wherever the row ends up — values.append decides the landing row
 * itself, and sorting or deleting rows in the Sheets UI moves everything after.
 */
const DAYS_FORMULA = (() => {
  const applied = `INDEX($${L('appliedAt')}:$${L('appliedAt')},ROW())`;
  const resp = `INDEX($${L('firstResponseAt')}:$${L('firstResponseAt')},ROW())`;
  return `=IFERROR(IF(AND(${applied}<>"",${resp}<>""),${resp}-${applied},""),"")`;
})();

/** One application record -> one row, in schema order. */
function toRow(app, settings) {
  const resumeLabel = app.resumeLabel || resumeLabelFor(app.resumeName, settings.resumeAliases);

  const value = (key) => {
    switch (key) {
      case 'appliedAt':         return U.isoDate(app.appliedAt);
      case 'firstResponseAt':   return U.isoDate(app.firstResponseAt);
      case 'interviewInviteAt': return U.isoDate(app.interviewInviteAt);
      case 'lastEmailAt':       return U.isoDate(app.lastEmailAt);
      case 'lastRoundDate':     return app.lastRoundDate || '';
      case 'updatedAt':         return U.isoDateTime(app.updatedAt);
      case 'jdUrl':             return hyperlink(app.jdUrl, app.position || app.jdUrl);
      case 'threadUrl':         return app.threadId ? hyperlink(`https://mail.google.com/mail/u/0/#all/${app.threadId}`, 'Open thread') : '';
      case 'gotInterview':      return app.gotInterview ? 'Yes' : 'No';
      case 'resumeLabel':       return resumeLabel;
      // Kept live so it stays correct if you edit the dates by hand.
      case 'daysToResponse':    return DAYS_FORMULA;
      default: {
        const v = app[key];
        return v === null || v === undefined ? '' : v;
      }
    }
  };
  return C.COLUMNS.map((c) => value(c.key));
}

/**
 * Push records to the Applications tab.
 * Existing App IDs are updated in place; the rest are appended. Row lookup is
 * done from column A on every push rather than trusting a cached row index,
 * because rows move when you sort or delete in the Sheets UI.
 */
export async function pushApps(appList) {
  if (!appList.length) return { updated: 0, appended: 0, rowIndexes: {} };
  const settings = await getSettings();
  const spreadsheetId = await ensureSpreadsheet();

  const idCol = await readValues(spreadsheetId, `${C.TAB_APPLICATIONS}!${L('id')}2:${L('id')}`);
  const rowById = new Map();
  idCol.forEach((r, i) => { const id = (r && r[0]) || ''; if (id) rowById.set(String(id), i + 2); });

  const updates = [];
  const appends = [];
  const rowIndexes = {};

  for (const app of appList) {
    const existingRow = rowById.get(app.id);
    if (existingRow) {
      updates.push({
        range: `${C.TAB_APPLICATIONS}!A${existingRow}:${LAST_COL}${existingRow}`,
        majorDimension: 'ROWS',
        values: [toRow(app, settings)],
      });
      rowIndexes[app.id] = existingRow;
    } else {
      appends.push(app);
    }
  }

  if (updates.length) {
    await api(`${C.SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
    });
  }

  if (appends.length) {
    const values = appends.map((app) => toRow(app, settings));
    const appended = await api(
      `${C.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${C.TAB_APPLICATIONS}!A1`)}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values }) }
    );
    // values.append reports where it actually landed; trust that over a guess.
    const firstNewRow = parseRangeStart(appended) || idCol.length + 2;
    appends.forEach((app, i) => { rowIndexes[app.id] = firstNewRow + i; });
  }

  return { updated: updates.length, appended: appends.length, rowIndexes };
}

/** Append classified emails to the Email Log tab (audit trail). */
export async function appendEvents(events) {
  if (!events.length) return;
  const spreadsheetId = await ensureSpreadsheet();
  const values = events.map((e) => [
    U.isoDateTime(e.receivedAt),
    e.company || '',
    e.position || '',
    e.from || '',
    (e.subject || '').slice(0, 300),
    e.classification || '',
    e.confidence == null ? '' : e.confidence,
    e.threadId ? hyperlink(`https://mail.google.com/mail/u/0/#all/${e.threadId}`, 'Open') : '',
  ]);
  await api(
    `${C.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${C.TAB_EVENTS}!A1`)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values }) }
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function tableBlock(title, rows, headers) {
  const out = [[title], headers];
  for (const r of rows) out.push(r);
  out.push(['']);
  return out;
}

/**
 * The headline KPIs are live formulas (so the sheet stays honest if you edit
 * rows by hand); the breakdown tables are snapshots written on each sync.
 */
export async function writeDashboard(stats) {
  const spreadsheetId = await ensureSpreadsheet();
  const A = C.TAB_APPLICATIONS;
  const c = (k) => `${A}!${L(k)}2:${L(k)}`;

  const totalF = `=SUMPRODUCT(--(${c('id')}<>""))`;
  const respF = `=SUMPRODUCT(--(${c('firstResponseAt')}<>""))`;
  const intF = `=COUNTIF(${c('gotInterview')},"Yes")`;
  const offerF = `=COUNTIF(${c('status')},"${C.STATUS.OFFER}")`;
  const rejF = `=COUNTIF(${c('status')},"${C.STATUS.REJECTED}")`;
  const ghostF = `=COUNTIF(${c('status')},"${C.STATUS.GHOSTED}")`;

  const rows = [];
  rows.push([`${C.EXT_NAME} — Job Search Dashboard`]);
  rows.push([`Last synced`, U.isoDateTime(new Date())]);
  rows.push(['']);
  rows.push(['HEADLINE', 'Count', 'Rate']);
  rows.push(['Applications submitted', totalF, '']);
  rows.push(['Heard back (any reply)', respF, '=IFERROR(B6/B5,"")']);
  rows.push(['Interview invites', intF, '=IFERROR(B7/B5,"")']);
  rows.push(['Offers', offerF, '=IFERROR(B8/B5,"")']);
  rows.push(['Rejections', rejF, '=IFERROR(B9/B5,"")']);
  rows.push([`Ghosted (${stats.ghostAfterDays}d no reply)`, ghostF, '=IFERROR(B10/B5,"")']);
  rows.push(['Awaiting response', stats.awaiting, '']);
  rows.push(['']);
  rows.push(['SPEED', 'Days', '']);
  rows.push(['Median days to first response', stats.medianDaysToResponse == null ? '—' : stats.medianDaysToResponse, '']);
  rows.push(['Median days to interview invite', stats.medianDaysToInterview == null ? '—' : stats.medianDaysToInterview, '']);
  rows.push(['']);
  rows.push(['COMPENSATION', 'Value', '']);
  rows.push(['Median posted comp (midpoint)', stats.medianCompMidpoint == null ? '—' : stats.medianCompMidpoint, '']);
  rows.push(['Postings with comp listed', `${stats.compCoverage}%`, '']);
  rows.push(['']);

  const headers = ['Bucket', 'Applied', 'Heard back', 'Interviews', 'Response %', 'Interview %'];
  const toRows = (list) => list.map((r) => [r.key, r.applied, r.responded, r.interviews, r.responseRate / 100, r.interviewRate / 100]);

  rows.push(...tableBlock('BY RESUME  — which version actually gets replies', toRows(stats.byResume), headers));
  rows.push(...tableBlock('BY WORK MODE', toRows(stats.byWorkMode), headers));
  rows.push(...tableBlock('BY COMPANY STAGE', toRows(stats.byStage), headers));
  rows.push(...tableBlock('BY BOARD / ATS', toRows(stats.byBoard), headers));
  rows.push(...tableBlock('BY WEEK APPLIED', toRows(stats.byWeek), headers));

  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => { const copy = r.slice(); while (copy.length < width) copy.push(''); return copy; });

  await api(
    `${C.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${C.TAB_DASHBOARD}!A1:${U.colLetter(width - 1)}${padded.length + 40}`)}:clear`,
    { method: 'POST', body: '{}' }
  );
  await writeValues(spreadsheetId, `${C.TAB_DASHBOARD}!A1`, padded);

  const ids = await sheetIds(spreadsheetId);
  const dashId = ids[C.TAB_DASHBOARD];
  await batchUpdate(spreadsheetId, [
    {
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: width },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    {
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: 4, endRowIndex: 11, startColumnIndex: 2, endColumnIndex: 3 },
        cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    {
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 6 },
        cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Pull manual edits back
// ---------------------------------------------------------------------------
/**
 * Read Status / Notes / Resume Version back out of the sheet so edits made in
 * Google Sheets survive the next push instead of being overwritten.
 */
export async function pullEdits() {
  const settings = await getSettings();
  if (!settings.spreadsheetId) return [];
  const rows = await readValues(settings.spreadsheetId, `${C.TAB_APPLICATIONS}!A2:${LAST_COL}`);
  const out = [];
  for (const row of rows) {
    const id = row[C.COL_INDEX.id];
    if (!id) continue;
    out.push({
      id: String(id),
      status: U.clean(row[C.COL_INDEX.status] || ''),
      notes: U.clean(row[C.COL_INDEX.notes] || ''),
      resumeLabel: U.clean(row[C.COL_INDEX.resumeLabel] || ''),
      companyStage: U.clean(row[C.COL_INDEX.companyStage] || ''),
      valuation: row[C.COL_INDEX.valuation] || null,
      totalRaised: row[C.COL_INDEX.totalRaised] || null,
      headcount: U.clean(row[C.COL_INDEX.headcount] || ''),
      workMode: U.clean(row[C.COL_INDEX.workMode] || ''),
    });
  }
  return out;
}
