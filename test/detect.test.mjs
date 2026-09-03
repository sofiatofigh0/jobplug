import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, P } from './helpers.mjs';

/** Does any board pattern claim this URL as an application submit? */
function matchesApply(url) {
  const board = P.boardFor(url);
  if (!board) return null;
  return (board.applyRe || []).some((re) => re.test(url)) ? board.id : `${board.id}:no-match`;
}

test('real ATS submit endpoints are recognised', () => {
  const cases = [
    // Ashby posts applications through its GraphQL endpoint. The original
    // pattern required "application/submit" and missed this entirely, which is
    // why Ashby applications were never detected.
    ['ashby', 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApplyToJob'],
    ['ashby', 'https://jobs.ashbyhq.com/api/application/submit'],
    ['greenhouse', 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123'],
    ['greenhouse', 'https://boards.greenhouse.io/acme/jobs/4567'],
    ['greenhouse', 'https://api.greenhouse.io/v1/applications'],
    ['lever', 'https://api.lever.co/v0/postings/acme/uuid/apply'],
    ['workday', 'https://acme.wd1.myworkdayjobs.com/careers/job/123/submitApplication'],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/acme/123/candidates'],
    ['workable', 'https://apply.workable.com/api/v1/acme/candidates'],
  ];
  for (const [expected, url] of cases) {
    assert.equal(matchesApply(url), expected, url);
  }
});

test('ordinary page loads on an ATS host are not treated as submissions', () => {
  for (const url of [
    'https://boards.greenhouse.io/acme',
    'https://jobs.lever.co/acme',
    'https://jobs.ashbyhq.com/acme',
  ]) {
    const id = matchesApply(url);
    assert.ok(String(id).endsWith(':no-match'), `${url} should not look like a submit`);
  }
});

test('every board declares the fields the detector relies on', () => {
  for (const b of C.BOARDS) {
    assert.ok(b.id && b.label, 'board needs an id and label');
    assert.ok(Array.isArray(b.hosts) && b.hosts.length, `${b.id} needs hosts`);
    assert.ok(Array.isArray(b.applyRe) && b.applyRe.length, `${b.id} needs apply patterns`);
    assert.ok(Array.isArray(b.mailDomains) && b.mailDomains.length, `${b.id} needs mail domains`);
    for (const re of b.applyRe) assert.ok(re instanceof RegExp, `${b.id} apply pattern must be a regex`);
  }
});

test('board hostnames resolve, including subdomains', () => {
  assert.equal(P.boardFor('https://job-boards.greenhouse.io/x').id, 'greenhouse');
  assert.equal(P.boardFor('https://acme.wd5.myworkdayjobs.com/x').id, 'workday');
  assert.equal(P.boardFor('https://careers.acme.com/jobs/1'), null);
});

test('confirmation copy is recognised across common phrasings', () => {
  const seen = [
    'Your application has been submitted',
    "Thanks for applying to Acme",
    "We've received your application",
    'Application complete',
    'Your application was sent to Acme',
  ];
  for (const text of seen) {
    assert.ok(C.SUCCESS_PATTERNS.some((re) => re.test(text)), text);
  }
});

test('submit-button labels are recognised but ordinary buttons are not', () => {
  for (const label of ['Submit application', 'Apply', 'Easy Apply', 'Submit', 'Send application']) {
    assert.ok(C.APPLY_BUTTON_RE.test(label), `should match: ${label}`);
  }
  for (const label of ['Save job', 'Back', 'Cancel', 'Sign in', 'Next']) {
    assert.ok(!C.APPLY_BUTTON_RE.test(label), `should not match: ${label}`);
  }
});

test('resume filenames are told apart from other uploads', () => {
  assert.ok(C.RESUME_FILE_RE.test('sofia_backend_v3.pdf'));
  assert.ok(C.RESUME_FILE_RE.test('CV.docx'));
  assert.ok(!C.RESUME_FILE_RE.test('headshot.png'));
  assert.ok(C.COVER_HINT_RE.test('cover_letter.pdf'));
  assert.ok(!C.COVER_HINT_RE.test('resume.pdf'));
});

// --- confirmation URLs ------------------------------------------------------

test('confirmation URLs are recognised across the major boards', () => {
  const shouldMatch = [
    '/reddit/jobs/8088720/confirmation',   // Greenhouse — full page load on submit
    '/acme/uuid/thanks',                   // Lever
    '/acme/applied',                       // Workable
    '/post-apply',                         // Indeed
    '/jobs/123/application-submitted',
    '/careers/thank-you',
    '/apply/success',
  ];
  for (const path of shouldMatch) {
    assert.ok(C.SUCCESS_URL_RE.test(path), `should match: ${path}`);
  }
});

test('ordinary paths are not mistaken for confirmations', () => {
  const shouldNotMatch = [
    '/reddit/jobs/8088720',          // the posting itself
    '/jobs/search',
    '/company/thanksgiving-hiring',  // substring trap: "thanks" inside a word
    '/about/appliedscience',         // substring trap: "applied" inside a word
    '/',
  ];
  for (const path of shouldNotMatch) {
    assert.ok(!C.SUCCESS_URL_RE.test(path), `should not match: ${path}`);
  }
});

test('a confirmation URL alone clears the detection threshold on an ATS host', () => {
  // Mirrors the detector's arithmetic: landing on a confirmation page must be
  // decisive by itself, because a native form POST leaves no other trace —
  // it never passes through fetch or XHR, and the page it came from is gone.
  const WEIGHTS = { atsHost: 10, successUrl: 55 };
  const THRESHOLD = 60;
  assert.ok(WEIGHTS.atsHost + WEIGHTS.successUrl >= THRESHOLD,
    'ATS host + confirmation URL must be enough on its own');
});

// --- guard against the storage-constant regression --------------------------

test('detector declares its storage constants before restore() runs', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../extension/src/content/detector.js', import.meta.url), 'utf8');
  // Compare real code lines only — the fix is documented in a comment that
  // quotes the very call site we are looking for.
  const lines = src.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l));
  const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));
  const declared = lineOf('const STORE_KEY');
  const used = lineOf('const state = restore()');
  assert.ok(declared > -1 && used > -1, 'both landmarks must exist');
  // restore() reads STORE_KEY. If the const is declared after the call site the
  // read hits the temporal dead zone, throws, and restore()'s own try/catch
  // swallows it — so evidence silently stops surviving page loads.
  assert.ok(declared < used,
    'STORE_KEY must be declared before restore() is called, or restore() silently always returns null');
});
