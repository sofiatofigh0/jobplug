import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, U, P } from './helpers.mjs';

test('parseMoney handles suffixes, symbols and separators', () => {
  assert.equal(P.parseMoney('$1.2M'), 1_200_000);
  assert.equal(P.parseMoney('45k'), 45_000);
  assert.equal(P.parseMoney('150,000'), 150_000);
  assert.equal(P.parseMoney('£2.5bn'), 2_500_000_000);
  assert.equal(P.parseMoney('not a number'), null);
});

test('parseSalary reads an annual range', () => {
  const s = P.parseSalary('The base salary range for this position is $180,000 - $220,000 per year.');
  assert.equal(s.annualMin, 180_000);
  assert.equal(s.annualMax, 220_000);
  assert.equal(s.currency, 'USD');
  assert.equal(s.period, 'year');
});

test('parseSalary annualises an hourly rate but keeps the original text', () => {
  const s = P.parseSalary('Pay rate: $75 - $95 per hour.');
  assert.equal(s.min, 75);
  assert.equal(s.annualMin, 75 * 2080);
  assert.match(s.raw, /hour/);
});

test('parseSalary ignores funding and vanity numbers', () => {
  const s = P.parseSalary('We have 10,000 customers and raised $50M. Base salary $120,000 — $145,000.');
  assert.equal(s.annualMin, 120_000);
  assert.equal(s.annualMax, 145_000);
});

test('parseSalary returns null when no pay is listed', () => {
  assert.equal(P.parseSalary('Fully remote role on a distributed team. Great benefits.'), null);
});

test('parseSalary handles non-USD currencies', () => {
  const s = P.parseSalary('Salary £60,000 to £75,000 per annum.');
  assert.equal(s.currency, 'GBP');
  assert.equal(s.annualMax, 75_000);
});

test('parseWorkMode distinguishes the three modes', () => {
  assert.equal(P.parseWorkMode('This is a fully remote position.', ''), C.WORK_MODE.REMOTE);
  assert.equal(P.parseWorkMode('Hybrid — 3 days a week in the office.', ''), C.WORK_MODE.HYBRID);
  assert.equal(P.parseWorkMode('This role is on-site in our New York office.', ''), C.WORK_MODE.ONSITE);
  assert.equal(P.parseWorkMode('A great opportunity for a builder.', ''), C.WORK_MODE.UNKNOWN);
});

test('parseWorkMode treats remote-friendly-with-an-office as hybrid', () => {
  assert.equal(
    P.parseWorkMode('We are remote-friendly but most of the team is in our SF office.', ''),
    C.WORK_MODE.HYBRID
  );
});

test('parseFunding extracts stage, raise, valuation and headcount', () => {
  const f = P.parseFunding(
    'We are a Series B company. We raised $50M in 2024 at a $500M valuation and are a team of 120 people.'
  );
  assert.equal(f.stage, 'Series B');
  assert.equal(f.totalRaised, 50_000_000);
  assert.equal(f.valuation, 500_000_000);
  assert.equal(f.headcount, '120');
});

test('parseFunding recognises public companies', () => {
  assert.equal(P.parseFunding('We are a publicly traded company listed on NASDAQ.').stage, 'Public');
});

test('parseFunding returns empties rather than guesses', () => {
  const f = P.parseFunding('We build software for dentists.');
  assert.equal(f.stage, '');
  assert.equal(f.totalRaised, null);
  assert.equal(f.valuation, null);
});

test('fromJsonLd maps a schema.org JobPosting', () => {
  const rec = P.fromJsonLd({
    '@type': 'JobPosting',
    title: 'Staff Engineer',
    hiringOrganization: { '@type': 'Organization', name: 'Acme Inc', sameAs: 'https://www.acme.com/about' },
    jobLocation: { address: { addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'US' } },
    jobLocationType: 'TELECOMMUTE',
    baseSalary: { currency: 'USD', value: { minValue: 190000, maxValue: 240000, unitText: 'YEAR' } },
    employmentType: 'FULL_TIME',
  });
  assert.equal(rec.position, 'Staff Engineer');
  assert.equal(rec.company, 'Acme Inc');
  assert.equal(rec.companyDomain, 'acme.com');
  assert.equal(rec.workMode, C.WORK_MODE.REMOTE);
  assert.equal(rec.salaryMin, 190_000);
  assert.equal(rec.salaryMax, 240_000);
  assert.equal(rec.location, 'New York, NY, US');
});

test('fromJsonLd annualises an hourly JobPosting salary', () => {
  const rec = P.fromJsonLd({
    '@type': 'JobPosting',
    baseSalary: { currency: 'USD', value: { minValue: 50, maxValue: 60, unitText: 'HOUR' } },
  });
  assert.equal(rec.salaryMin, 50 * 2080);
  assert.match(rec.salaryRaw, /hour/);
});

test('boardFor identifies ATS hosts including subdomains', () => {
  assert.equal(P.boardFor('https://boards.greenhouse.io/acme/jobs/1').id, 'greenhouse');
  assert.equal(P.boardFor('https://jobs.lever.co/acme/uuid').id, 'lever');
  assert.equal(P.boardFor('https://acme.wd1.myworkdayjobs.com/careers/job/1').id, 'workday');
  assert.equal(P.boardFor('https://example.com/careers'), null);
});

test('rootDomain respects multi-label public suffixes', () => {
  assert.equal(U.rootDomain('https://careers.acme.co.uk/jobs'), 'acme.co.uk');
  assert.equal(U.rootDomain('boards.greenhouse.io'), 'greenhouse.io');
});

test('normCompany strips legal suffixes and careers noise', () => {
  assert.equal(U.normCompany('Acme Technologies, Inc. | Careers'), 'acme');
  assert.equal(U.normCompany('Acme'), U.normCompany('Acme LLC'));
});

test('normTitle drops requisition ids and location noise', () => {
  assert.equal(
    U.normTitle('Senior Software Engineer (Remote) — Req #12345'),
    U.normTitle('Senior Software Engineer')
  );
});
