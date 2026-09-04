import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, El } from './dom-harness.mjs';

/**
 * End-to-end through the real content scripts.
 *
 * Every earlier test exercised pure helpers, which is why a stack overflow that
 * killed the whole detector at load went unnoticed through several rounds of
 * "fixes" — the helpers were all fine; the script that used them never ran.
 */

test('the content scripts load without throwing', async () => {
  const page = await loadPage({
    url: 'https://job-boards.greenhouse.io/reddit/jobs/8088720',
    title: 'Staff Engineer at Reddit',
    body: [new El('h1', { class: 'app-title' }, 'Staff Engineer')],
  });
  try {
    assert.deepEqual(page.errors.map((e) => `${e.file || ''}: ${e.message}`), [],
      'a throw here disables detection entirely, silently');
  } finally { page.restore(); }
});

test('a Greenhouse confirmation page is captured on its own', async () => {
  const page = await loadPage({
    url: 'https://job-boards.greenhouse.io/reddit/jobs/8088720/confirmation',
    title: 'Reddit',
    body: [new El('div', {}, 'Thank you for applying. Your application has been submitted.')],
  });
  try {
    assert.equal(page.errors.length, 0, page.errors.map((e) => e.message).join('; '));
    const cap = page.messages.find((m) => m.type === 'CAPTURE');
    assert.ok(cap, 'landing on a confirmation URL must capture the application');
    assert.equal(cap.payload.record.company, 'Reddit');
    assert.equal(cap.payload.record.board, 'Greenhouse');
    assert.ok(cap.payload.evidence.reasons.includes('successUrl(confirmation)'),
      `expected the confirmation URL to count; got ${cap.payload.evidence.reasons.join(', ')}`);
  } finally { page.restore(); }
});

test('confirmation copy on screen does not send the detector into recursion', async () => {
  // The regression: armSuccessObserver ran its first scan before assigning the
  // observer, so addEvidence saw a null observer and re-armed — check ->
  // addEvidence -> arm -> check, until the stack blew and the script died.
  const page = await loadPage({
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    title: 'Acme',
    body: [new El('div', {}, 'Your application has been submitted. Thanks for applying!')],
  });
  try {
    const overflow = page.errors.find((e) => e instanceof RangeError);
    assert.equal(overflow, undefined, 'success text must not cause unbounded re-arming');
    assert.equal(page.errors.length, 0);
  } finally { page.restore(); }
});

test('a plain job posting is not mistaken for a submission', async () => {
  const page = await loadPage({
    url: 'https://job-boards.greenhouse.io/reddit/jobs/8088720',
    title: 'Staff Engineer at Reddit',
    body: [
      new El('h1', { class: 'app-title' }, 'Staff Engineer'),
      new El('div', {}, 'Apply for this job. We are hiring across the company.'),
    ],
  });
  try {
    assert.equal(page.messages.find((m) => m.type === 'CAPTURE'), undefined,
      'merely viewing a posting must never log an application');
  } finally { page.restore(); }
});

test('the job page is reported so an apply page can inherit its details', async () => {
  const page = await loadPage({
    url: 'https://job-boards.greenhouse.io/reddit/jobs/8088720',
    title: 'Staff Engineer at Reddit',
    body: [new El('h1', { class: 'app-title' }, 'Staff Engineer')],
    settle: 1500,   // reportSeen is debounced at 1200ms
  });
  try {
    const seen = page.messages.find((m) => m.type === 'SEEN_JOB');
    assert.ok(seen, 'the posting should be remembered for the tab');
    assert.equal(seen.payload.record.company, 'Reddit');
  } finally { page.restore(); }
});

test('a resume upload followed by a successful apply request is captured', async () => {
  const page = await loadPage({
    url: 'https://jobs.ashbyhq.com/acme/1234-5678',
    title: 'Backend Engineer at Acme',
    body: [new El('h1', {}, 'Backend Engineer')],
  });
  try {
    // The MAIN-world hook relays both of these via window.postMessage.
    page.win.postMessage({
      __JAT_NET__: true, kind: 'file', url: page.win.location.href,
      files: [{ field: 'resume', name: 'sofia_backend_v3.pdf', size: 120000, type: 'application/pdf' }],
    });
    page.win.postMessage({
      __JAT_NET__: true, kind: 'net', via: 'fetch', method: 'POST', ok: true, status: 200,
      url: 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApplyToJob', files: [],
    });
    await new Promise((r) => setTimeout(r, 30));

    const cap = page.messages.find((m) => m.type === 'CAPTURE');
    assert.ok(cap, 'resume + successful apply request must capture');
    assert.equal(cap.payload.record.resumeName, 'sofia_backend_v3.pdf');
    assert.equal(cap.payload.record.board, 'Ashby');
  } finally { page.restore(); }
});

test('a resume upload alone is not enough', async () => {
  const page = await loadPage({
    url: 'https://jobs.ashbyhq.com/acme/1234-5678',
    title: 'Backend Engineer at Acme',
    body: [new El('h1', {}, 'Backend Engineer')],
  });
  try {
    page.win.postMessage({
      __JAT_NET__: true, kind: 'file', url: page.win.location.href,
      files: [{ field: 'resume', name: 'resume.pdf', size: 1000, type: 'application/pdf' }],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(page.messages.find((m) => m.type === 'CAPTURE'), undefined,
      'attaching a file is not the same as submitting');
  } finally { page.restore(); }
});
