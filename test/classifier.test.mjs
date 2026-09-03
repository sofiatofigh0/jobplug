import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C } from './helpers.mjs';
const { classifyEmail, matchesApplication } = await import('../extension/src/background/classifier.js');

const mail = (subject, body, from = 'recruiting@acme.com') =>
  ({ subject, body, snippet: body.slice(0, 120), from });

test('a scheduling request is an interview invite', () => {
  const r = classifyEmail(mail(
    'Next steps for your Senior Engineer application',
    'Hi, we would love to set up a 30-minute call with the hiring manager. Book a time: https://calendly.com/acme/intro'
  ));
  assert.equal(r.category, 'INTERVIEW_INVITE');
  assert.equal(r.isInvite, true);
  assert.equal(r.status, C.STATUS.SCREEN);
});

test('rejection wins even when the word "interview" appears', () => {
  const r = classifyEmail(mail(
    'Update on your application',
    'Thank you for interviewing with us. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches the role. We will keep your resume on file.'
  ));
  assert.equal(r.category, 'REJECTION');
  assert.equal(r.isInvite, false);
  assert.equal(r.status, C.STATUS.REJECTED);
});

test('a bare autoresponder is only an acknowledgement', () => {
  const r = classifyEmail(mail(
    'We received your application',
    'Thank you for applying to Acme. Your application has been received and our team will review it shortly.'
  ));
  assert.equal(r.category, 'ACKNOWLEDGEMENT');
  assert.equal(r.isInvite, false);
});

test('an acknowledgement that also schedules is promoted to an invite', () => {
  const r = classifyEmail(mail(
    'Thanks for applying — and a quick call?',
    'Thank you for your application. Could you share your availability so we can schedule an initial recruiter call?'
  ));
  assert.equal(r.category, 'INTERVIEW_INVITE');
  assert.equal(r.isInvite, true);
});

test('offers are recognised and outrank invites', () => {
  const r = classifyEmail(mail('Offer — Senior Engineer', 'We are thrilled to extend an offer of employment. Your offer letter is attached.'));
  assert.equal(r.category, 'OFFER');
  assert.equal(r.status, C.STATUS.OFFER);
  assert.equal(r.isInvite, true);
});

test('take-home assignments are their own stage, not an interview', () => {
  const r = classifyEmail(mail('Coding challenge', 'Please complete the HackerRank technical assessment within 5 days.'));
  assert.equal(r.category, 'ASSESSMENT');
  assert.equal(r.status, C.STATUS.ASSESSMENT);
  assert.equal(r.isInvite, false, 'an assessment must not count as an interview invite');
});

test('job alerts are discarded as noise', () => {
  for (const subject of ['25 new jobs for you', 'Job alert: Software Engineer', 'Recommended jobs this week']) {
    assert.equal(classifyEmail(mail(subject, 'New jobs matching your search. Unsubscribe.')).category, 'NOISE', subject);
  }
});

test('cold recruiter outreach is not treated as a response', () => {
  const r = classifyEmail(mail(
    'Exciting opportunity',
    'I came across your profile on LinkedIn. I am a technical recruiter at Foo — would you be open to hearing about a new opportunity?'
  ));
  assert.equal(r.category, 'OUTREACH');
  assert.equal(r.status, null);
});

test('unremarkable mail classifies as OTHER rather than guessing', () => {
  const r = classifyEmail(mail('Re: your question', 'Sure, the office is on the third floor. See you around.'));
  assert.equal(r.category, 'OTHER');
  assert.equal(r.status, null);
});

// --- matching ---------------------------------------------------------------
const app = {
  company: 'Acme Robotics, Inc.',
  companyDomain: 'acme.com',
  position: 'Senior Software Engineer, Platform',
};

test('a sender-domain match alone is enough', () => {
  const m = matchesApplication({ from: 'recruiting@acme.com', subject: 'Hello', snippet: '', body: '' }, app);
  assert.equal(m.matched, true);
  assert.deepEqual(m.why, ['domain']);
});

test('a subdomain of the company domain still matches', () => {
  const m = matchesApplication({ from: 'noreply@mail.acme.com', subject: 'Hi', snippet: '', body: '' }, app);
  assert.equal(m.matched, true);
});

test('an ATS sender needs company AND title corroboration', () => {
  const weak = matchesApplication(
    { from: 'no-reply@us.greenhouse-mail.io', subject: 'Acme Robotics', snippet: 'hello there', body: '' }, app);
  assert.equal(weak.matched, false, 'company name alone via an ATS is ambiguous');

  const strong = matchesApplication(
    { from: 'no-reply@us.greenhouse-mail.io', subject: 'Acme Robotics', snippet: 'senior software engineer platform', body: '' }, app);
  assert.equal(strong.matched, true);
});

test('unrelated mail does not match', () => {
  const m = matchesApplication({ from: 'news@random.io', subject: 'Newsletter', snippet: 'nothing here', body: '' }, app);
  assert.equal(m.matched, false);
  assert.equal(m.score, 0);
});
