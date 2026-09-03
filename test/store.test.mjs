import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, resetStorage } from './helpers.mjs';
const S = await import('../extension/src/background/store.js');

const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('makeId is stable across cosmetic differences', () => {
  const a = S.makeId({ company: 'Acme Inc.', position: 'Senior Engineer (Remote)', boardId: 'greenhouse' });
  const b = S.makeId({ company: 'Acme', position: 'Senior Engineer', boardId: 'greenhouse' });
  assert.equal(a, b, 'legal suffix and location noise must not create a duplicate row');
});

test('makeId separates different roles at the same company', () => {
  const a = S.makeId({ company: 'Acme', position: 'Backend Engineer', boardId: 'lever' });
  const b = S.makeId({ company: 'Acme', position: 'Frontend Engineer', boardId: 'lever' });
  assert.notEqual(a, b);
});

test('makeId falls back to the URL when there is no company or title', () => {
  const id = S.makeId({ jdUrl: 'https://example.com/jobs/42?utm=x' });
  assert.equal(id, S.makeId({ jdUrl: 'https://example.com/jobs/42?utm=y' }));
});

test('mergeStatus only advances automatically', () => {
  assert.equal(S.mergeStatus(C.STATUS.INTERVIEW, C.STATUS.ACKNOWLEDGED), C.STATUS.INTERVIEW);
  assert.equal(S.mergeStatus(C.STATUS.APPLIED, C.STATUS.INTERVIEW), C.STATUS.INTERVIEW);
  assert.equal(S.mergeStatus(C.STATUS.INTERVIEW, C.STATUS.REJECTED), C.STATUS.REJECTED);
});

test('mergeStatus lets a manual edit move a status backwards', () => {
  assert.equal(S.mergeStatus(C.STATUS.REJECTED, C.STATUS.APPLIED, true), C.STATUS.APPLIED);
});

test('any real signal clears the soft Ghosted state', () => {
  assert.equal(S.mergeStatus(C.STATUS.GHOSTED, C.STATUS.ACKNOWLEDGED), C.STATUS.ACKNOWLEDGED);
});

test('resumeLabelFor prefers a configured alias', () => {
  const aliases = [{ match: 'backend_v3', label: 'Backend v3' }];
  assert.equal(S.resumeLabelFor('sofia_backend_v3_final.pdf', aliases), 'Backend v3');
});

test('resumeLabelFor falls back to a cleaned filename', () => {
  assert.equal(S.resumeLabelFor('sofia_resume.pdf', []), 'sofia_resume');
});

test('upsertApp merges without losing known values', async () => {
  resetStorage();
  await S.upsertApp({
    company: 'Acme', position: 'Engineer', boardId: 'lever',
    salaryMin: 150000, workMode: 'Remote', appliedAt: day(3),
  });
  // A later Gmail update knows nothing about pay or work mode.
  const { app, created } = await S.upsertApp({
    company: 'Acme', position: 'Engineer', boardId: 'lever',
    status: C.STATUS.INTERVIEW, gotInterview: true, firstResponseAt: day(1),
  });
  assert.equal(created, false, 'must update the existing row, not add a second');
  assert.equal(app.salaryMin, 150000);
  assert.equal(app.workMode, 'Remote');
  assert.equal(app.status, C.STATUS.INTERVIEW);
  assert.equal(app.gotInterview, true);
});

test('upsertApp keeps the earliest first response and the latest email', async () => {
  resetStorage();
  const base = { company: 'Acme', position: 'Engineer', boardId: 'lever' };
  await S.upsertApp({ ...base, firstResponseAt: day(5), lastEmailAt: day(5) });
  const { app } = await S.upsertApp({ ...base, firstResponseAt: day(2), lastEmailAt: day(1) });
  assert.equal(app.firstResponseAt, day(5).slice(0, 10) + app.firstResponseAt.slice(10));
  assert.ok(new Date(app.lastEmailAt) > new Date(day(2)));
});

// --- aggregates -------------------------------------------------------------
const sample = [
  { id: '1', appliedAt: day(30), status: C.STATUS.INTERVIEW, gotInterview: true,  firstResponseAt: day(25), interviewInviteAt: day(25), resumeLabel: 'Backend v3', workMode: 'Remote', companyStage: 'Series B', board: 'Greenhouse', salaryMin: 180000, salaryMax: 220000 },
  { id: '2', appliedAt: day(28), status: C.STATUS.REJECTED,  gotInterview: false, firstResponseAt: day(20), resumeLabel: 'Backend v3', workMode: 'Hybrid', companyStage: 'Seed',     board: 'Lever',      salaryMin: 150000, salaryMax: 170000 },
  { id: '3', appliedAt: day(26), status: C.STATUS.APPLIED,   gotInterview: false, resumeLabel: 'Generalist',  workMode: 'Onsite', companyStage: 'Public',   board: 'Greenhouse' },
  { id: '4', appliedAt: day(10), status: C.STATUS.OFFER,     gotInterview: true,  firstResponseAt: day(6), interviewInviteAt: day(6), resumeLabel: 'Backend v3', workMode: 'Remote', companyStage: 'Series B', board: 'Lever', salaryMin: 200000, salaryMax: 240000 },
];

test('computeStats counts the headline numbers', () => {
  const s = S.computeStats(sample, {});
  assert.equal(s.total, 4);
  assert.equal(s.responded, 3);
  assert.equal(s.interviews, 2);
  assert.equal(s.offers, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.awaiting, 1);
  assert.equal(s.responseRate, 75);
  assert.equal(s.interviewRate, 50);
});

test('computeStats derives medians for speed and comp', () => {
  const s = S.computeStats(sample, {});
  assert.equal(s.medianDaysToResponse, 5);   // 5, 8, 4 -> 5
  assert.equal(s.medianDaysToInterview, 5);  // 4 and 5 -> mean 4.5, rounded to 5
  assert.equal(s.medianCompMidpoint, 200000);
  assert.equal(s.compCoverage, 75);
});

test('computeStats breaks results down by resume', () => {
  const s = S.computeStats(sample, {});
  const backend = s.byResume.find((r) => r.key === 'Backend v3');
  assert.equal(backend.applied, 3);
  assert.equal(backend.interviews, 2);
  assert.equal(backend.responseRate, 100);
  assert.equal(backend.interviewRate, 66.7);

  const generalist = s.byResume.find((r) => r.key === 'Generalist');
  assert.equal(generalist.applied, 1);
  assert.equal(generalist.interviews, 0);
});

test('computeStats groups by work mode, stage and board', () => {
  const s = S.computeStats(sample, {});
  assert.equal(s.byWorkMode.find((r) => r.key === 'Remote').applied, 2);
  assert.equal(s.byStage.find((r) => r.key === 'Series B').interviews, 2);
  assert.equal(s.byBoard.find((r) => r.key === 'Greenhouse').applied, 2);
});

test('computeStats is safe on an empty history', () => {
  const s = S.computeStats([], {});
  assert.equal(s.total, 0);
  assert.equal(s.responseRate, 0);
  assert.equal(s.medianDaysToResponse, null);
  assert.deepEqual(s.byResume, []);
});

test('the seen-job cache survives a service worker restart', async () => {
  resetStorage();
  // storage.session, unlike a module-level Map, outlives the worker being torn
  // down — which happens after ~30s idle, far shorter than filling in a form.
  await S.rememberSeen(7, { company: 'Reddit', position: 'Staff Engineer' });
  const back = await S.recallSeen(7);
  assert.equal(back.company, 'Reddit');
  assert.equal(back.position, 'Staff Engineer');
});

test('the seen-job cache expires and isolates tabs', async () => {
  resetStorage();
  await S.rememberSeen(1, { company: 'Acme' });
  assert.equal(await S.recallSeen(2), null, 'must not leak between tabs');
  assert.equal(await S.recallSeen(1, -1), null, 'must respect the age limit');
  assert.equal(await S.recallSeen(null), null);
});
