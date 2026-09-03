import '../common/constants.js';
import '../common/util.js';

const { C, U } = globalThis.JAT;

/**
 * Rule-based classification of recruiting email.
 *
 * Deliberately not a model: the vocabulary of ATS email is small, highly
 * templated, and the cost of a false "you got an interview" is high. Each
 * category accumulates weighted matches; the winner must clear a floor and
 * beat the runner-up. Rejection outranks everything because rejection copy
 * routinely contains the word "interview".
 */

const RULES = {
  REJECTION: [
    [/regret to inform/i, 7],
    [/not (be )?(moving|proceeding|progressing) forward/i, 6],
    [/will not be (moving|proceeding|progressing)/i, 6],
    [/decided (not to (move|proceed)|to move forward with (other|another)|to pursue other)/i, 6],
    [/other (candidates?|applicants?) whose (experience|background|qualifications)/i, 6],
    [/no longer (be )?(under consideration|being considered)/i, 6],
    [/(position|role|req(uisition)?) (has been|was) (filled|closed|cancelled|canceled|put on hold)/i, 5],
    [/not (a|the right) (fit|match)( for)?( this)?( role| position| time)?/i, 5],
    [/unfortunately[,]? (we|i|you|your|at this)/i, 5],
    [/we (have |'ve )?decided to (move|go) (forward|ahead) with/i, 5],
    [/keep your (resume|cv|application|profile|details) on file/i, 3],
    [/after (careful|thorough) (consideration|review)/i, 3],
    [/wish you (the (very )?best|luck|success|well)/i, 2],
    [/(was|were) not selected/i, 5],
    [/moving forward with other candidates/i, 6],
  ],

  OFFER: [
    [/(pleased|excited|thrilled|delighted|happy) to (extend|offer|present)/i, 8],
    [/offer letter/i, 7],
    [/(formal|written|verbal) offer/i, 7],
    [/we('| woul)?d like to offer you/i, 8],
    [/offer of employment/i, 8],
  ],

  INTERVIEW_INVITE: [
    [/invite you to (an? )?(interview|next round|onsite|final|panel)/i, 7],
    [/interview (invitation|request|scheduled|confirmation|availability)/i, 7],
    [/(would|we'd|i'd) (like|love) to (invite you|set up|schedule|arrange|chat|speak|talk|meet|connect)/i, 6],
    [/schedule (a|an|some)? ?(time|call|chat|interview|conversation|meeting|screen)/i, 6],
    [/book (a|some) time/i, 6],
    [/\b(calendly|savvycal|cal\.com|scheduleonce|youcanbook|goodtime|modernloop|hubspot\.com\/meetings|greenhouse\.io\/scheduling)\b/i, 6],
    [/move (you )?(forward|on) to (the )?(interview|next (round|step|stage))/i, 6],
    [/(phone|initial|introductory|intro|recruiter|hiring manager) (screen|call|chat|interview|conversation)/i, 5],
    [/what (does your|is your) (calendar|schedule|availability)/i, 5],
    [/(share|send|let me know) (your|some) (availability|times)/i, 5],
    [/are you (available|free) (for|to|on|this|next)/i, 4],
    [/set up a (call|chat|time|conversation|meeting)/i, 5],
    [/next steps? (in|for|of) (the|your|our)/i, 3],
    [/looking forward to (speaking|meeting|chatting|talking) with you/i, 3],
    [/(30|45|60)[- ]minute (call|chat|conversation|interview)/i, 5],
  ],

  ASSESSMENT: [
    [/(coding|technical|online|skills|written) (challenge|assessment|test|exercise)/i, 6],
    [/take[- ]?home (assignment|exercise|project|challenge)/i, 7],
    [/\b(hackerrank|codility|codesignal|coderpad|karat|woven|byteboard|testgorilla|dayforce assessment)\b/i, 7],
    [/complete (the|this|a) (assessment|challenge|exercise)/i, 5],
  ],

  ACKNOWLEDGEMENT: [
    [/(we|i) (have |'ve )?received your application/i, 6],
    [/your application (has been|was|is) (received|submitted|complete)/i, 6],
    [/thank you for (applying|your (application|interest|submission))/i, 5],
    [/thanks for (applying|your (application|interest))/i, 5],
    [/application (received|confirmation|submitted)/i, 5],
    [/we are (currently )?reviewing (your|all) application/i, 4],
    [/our team will review/i, 3],
  ],
};

/**
 * Hard excludes. Job alerts and marketing outnumber real recruiter mail by an
 * order of magnitude and would otherwise poison every metric.
 */
const NOISE = [
  /\b\d+\s+new jobs?\b/i,
  /jobs? (alert|recommendations?|picks?|for you|you may be interested)/i,
  /new (jobs?|roles?|opportunities) (matching|posted|for)/i,
  /\bjob alert\b/i,
  /recommended (jobs?|for you)/i,
  /your job search/i,
  /people you may know/i,
  /(newsletter|webinar|unsubscribe from all|marketing preferences)/i,
  /\bdigest\b/i,
  /invitation to connect/i,
  /(salary|market) (report|insights) for/i,
];

/** Cold outreach about a *different* job is not a response to your application. */
const OUTREACH = [
  /came across your (profile|resume|background|linkedin)/i,
  /found your (profile|resume) on/i,
  /i (am|'m) a (technical )?recruiter (at|with|for)/i,
  /would you be (open|interested) (to|in) (hearing|learning|exploring)/i,
  /reaching out (about|regarding) (an|a) (exciting|new) (opportunity|role)/i,
];

const CATEGORY_STATUS = {
  OFFER: C.STATUS.OFFER,
  REJECTION: C.STATUS.REJECTED,
  INTERVIEW_INVITE: C.STATUS.SCREEN,
  ASSESSMENT: C.STATUS.ASSESSMENT,
  ACKNOWLEDGEMENT: C.STATUS.ACKNOWLEDGED,
  OUTREACH: null,
  NOISE: null,
  OTHER: null,
};

/** Categories that mean "they invited me to talk to a human". */
const INVITE_CATEGORIES = new Set(['INTERVIEW_INVITE', 'OFFER']);

const MIN_SCORE = 5;

function scoreCategory(text, rules) {
  let score = 0;
  const matched = [];
  for (const [re, weight] of rules) {
    if (re.test(text)) { score += weight; matched.push(re.source.slice(0, 40)); }
  }
  return { score, matched };
}

/**
 * @param {{subject:string, snippet:string, body:string, from:string, listUnsubscribe?:string}} mail
 * @returns {{category:string, status:string|null, confidence:number, isInvite:boolean, matched:string[]}}
 */
export function classifyEmail(mail) {
  const subject = U.clean(mail.subject || '');
  const body = U.clean(`${mail.snippet || ''} ${mail.body || ''}`).slice(0, 12000);
  // Subject lines are short and highly signal-dense, so weight them twice.
  const text = `${subject} \n ${subject} \n ${body}`;

  if (NOISE.some((re) => re.test(subject)) || (mail.listUnsubscribe && NOISE.some((re) => re.test(text)))) {
    return { category: 'NOISE', status: null, confidence: 0.9, isInvite: false, matched: ['noise'] };
  }

  const scores = {};
  for (const [cat, rules] of Object.entries(RULES)) scores[cat] = scoreCategory(text, rules);

  // Rejection wins ties and near-ties: rejection templates frequently contain
  // "we will not be moving you forward to the interview stage".
  if (scores.REJECTION.score >= MIN_SCORE) {
    const rivals = Math.max(scores.INTERVIEW_INVITE.score, scores.OFFER.score);
    if (scores.REJECTION.score >= rivals - 2) {
      return finalize('REJECTION', scores.REJECTION);
    }
  }

  if (OUTREACH.some((re) => re.test(text)) && scores.ACKNOWLEDGEMENT.score < MIN_SCORE) {
    // Only treat as outreach if it isn't also clearly about scheduling with us.
    if (scores.INTERVIEW_INVITE.score < 8) {
      return { category: 'OUTREACH', status: null, confidence: 0.6, isInvite: false, matched: ['cold outreach'] };
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  const [topCat, top] = ranked[0];
  if (top.score < MIN_SCORE) {
    return { category: 'OTHER', status: null, confidence: 0.2, isInvite: false, matched: [] };
  }

  // An acknowledgement that also schedules something is an invite.
  if (topCat === 'ACKNOWLEDGEMENT' && scores.INTERVIEW_INVITE.score >= MIN_SCORE) {
    return finalize('INTERVIEW_INVITE', scores.INTERVIEW_INVITE);
  }
  return finalize(topCat, top);
}

function finalize(category, result) {
  return {
    category,
    status: CATEGORY_STATUS[category] || null,
    confidence: Math.min(1, Math.round((result.score / 12) * 100) / 100),
    isInvite: INVITE_CATEGORIES.has(category),
    matched: result.matched.slice(0, 5),
  };
}

/**
 * Does this message plausibly concern this application?
 * Requires a domain match, a company-name match, or an exact job-title match —
 * a bare ATS sender is not enough, since one ATS mails on behalf of thousands
 * of companies.
 */
export function matchesApplication(mail, app) {
  const from = (mail.from || '').toLowerCase();
  const fromDomain = (from.match(/@([a-z0-9.-]+)/) || [])[1] || '';
  const haystack = U.clean(`${mail.subject || ''} ${mail.snippet || ''} ${mail.body || ''}`).toLowerCase();
  const fromName = U.clean((mail.from || '').replace(/<[^>]*>/, ''));

  let score = 0;
  const why = [];

  if (app.companyDomain) {
    const root = U.rootDomain(app.companyDomain);
    if (root && fromDomain && (fromDomain === root || fromDomain.endsWith('.' + root))) { score += 6; why.push('domain'); }
  }

  const companyNorm = U.normCompany(app.company || '');
  if (companyNorm && companyNorm.length >= 3) {
    const needle = companyNorm.replace(/\s+/g, '');
    const fromNorm = U.normCompany(fromName + ' ' + fromDomain).replace(/\s+/g, '');
    if (fromNorm.includes(needle)) { score += 5; why.push('company-in-sender'); }
    else if (U.normCompany(haystack).replace(/\s+/g, '').includes(needle)) { score += 3; why.push('company-in-body'); }
  }

  const titleNorm = U.normTitle(app.position || '');
  if (titleNorm && titleNorm.length >= 6) {
    const words = titleNorm.split(' ').filter((w) => w.length > 3);
    const hits = words.filter((w) => haystack.includes(w)).length;
    if (words.length && hits / words.length >= 0.7) { score += 3; why.push('title'); }
  }

  // ATS sender adds confidence only on top of a name/title signal.
  const isAts = C.ALL_ATS_MAIL_DOMAINS.some((d) => fromDomain === d || fromDomain.endsWith('.' + d));
  if (isAts && score > 0) { score += 2; why.push('ats-sender'); }

  // 6 requires two independent signals (or a sender-domain match on its own):
  // one ATS domain fronts thousands of employers, so a name mention alone in a
  // Greenhouse email is not evidence about *which* application it concerns.
  return { matched: score >= 6, score, why };
}

export const _internals = { RULES, NOISE, OUTREACH, MIN_SCORE };
