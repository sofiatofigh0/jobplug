/**
 * Shared constants. Written as a classic script that publishes onto globalThis
 * so the exact same file can be used as a manifest content script (which cannot
 * be an ES module) and imported for side effects by the module service worker.
 */
(function (root) {
  const C = {};

  C.EXT_NAME = 'JobPlug';
  C.SCHEMA_VERSION = 3;

  // ---------------------------------------------------------------------------
  // Google
  // ---------------------------------------------------------------------------
  C.SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ];
  C.SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
  C.GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  C.USERINFO_API = 'https://www.googleapis.com/oauth2/v3/userinfo';

  C.TAB_APPLICATIONS = 'Applications';
  C.TAB_EVENTS = 'Email Log';
  C.TAB_DASHBOARD = 'Dashboard';

  // ---------------------------------------------------------------------------
  // Application status state machine.
  // Rank matters: status only advances, except REJECTED/OFFER which are terminal
  // and may be applied from any earlier state.
  // ---------------------------------------------------------------------------
  C.STATUS = {
    APPLIED: 'Applied',
    ACKNOWLEDGED: 'Acknowledged',
    ASSESSMENT: 'Assessment / Take-home',
    SCREEN: 'Recruiter Screen',
    INTERVIEW: 'Interview',
    ONSITE: 'Onsite / Final',
    OFFER: 'Offer',
    REJECTED: 'Rejected',
    WITHDRAWN: 'Withdrawn',
    GHOSTED: 'Ghosted',
  };
  C.STATUS_RANK = {
    Applied: 0,
    Ghosted: 1,
    Acknowledged: 2,
    'Assessment / Take-home': 3,
    'Recruiter Screen': 4,
    Interview: 5,
    'Onsite / Final': 6,
    Offer: 7,
    Rejected: 8,
    Withdrawn: 9,
  };
  // Statuses that count as "heard back with an interview invite".
  C.INTERVIEW_STATUSES = new Set([
    C.STATUS.SCREEN,
    C.STATUS.INTERVIEW,
    C.STATUS.ONSITE,
    C.STATUS.OFFER,
  ]);
  C.TERMINAL_STATUSES = new Set([C.STATUS.REJECTED, C.STATUS.WITHDRAWN, C.STATUS.OFFER]);

  C.WORK_MODE = { REMOTE: 'Remote', HYBRID: 'Hybrid', ONSITE: 'Onsite', UNKNOWN: '' };

  // Days with no inbound email after which an application is auto-marked Ghosted.
  C.GHOST_AFTER_DAYS = 21;

  // ---------------------------------------------------------------------------
  // Column schema. Order here == column order in the Applications sheet.
  // `key` matches the application record field name.
  // ---------------------------------------------------------------------------
  C.COLUMNS = [
    { key: 'id',                header: 'App ID',            width: 130, note: 'Stable dedupe key (board + company + role).' },
    { key: 'appliedAt',         header: 'Date Applied',      width: 105, type: 'DATE' },
    { key: 'company',           header: 'Company',           width: 170 },
    { key: 'position',          header: 'Position',          width: 240 },
    { key: 'jdUrl',             header: 'Job Description',   width: 200, type: 'LINK' },
    { key: 'board',             header: 'Board / ATS',       width: 120 },
    { key: 'location',          header: 'Location',          width: 160 },
    { key: 'workMode',          header: 'Work Mode',         width: 95,  note: 'Remote / Hybrid / Onsite' },
    { key: 'salaryMin',         header: 'Comp Min',          width: 100, type: 'MONEY' },
    { key: 'salaryMax',         header: 'Comp Max',          width: 100, type: 'MONEY' },
    { key: 'salaryRaw',         header: 'Comp (as listed)',  width: 170 },
    { key: 'resumeName',        header: 'Resume',            width: 190, note: 'Filename of the resume uploaded.' },
    { key: 'resumeLabel',       header: 'Resume Version',    width: 130, note: 'Your alias for this resume, set in Options.' },
    { key: 'coverLetter',       header: 'Cover Letter',      width: 170 },
    { key: 'companyStage',      header: 'Stage',             width: 105, note: 'Seed / Series A / Public / ...' },
    { key: 'valuation',         header: 'Valuation',         width: 110, type: 'MONEY' },
    { key: 'totalRaised',       header: 'Total Raised',      width: 110, type: 'MONEY' },
    { key: 'lastRound',         header: 'Last Round',        width: 110 },
    { key: 'lastRoundDate',     header: 'Last Round Date',   width: 110, type: 'DATE' },
    { key: 'headcount',         header: 'Headcount',         width: 95 },
    { key: 'industry',          header: 'Industry',          width: 150 },
    { key: 'companyDomain',     header: 'Company Domain',    width: 150 },
    { key: 'status',            header: 'Status',            width: 130 },
    { key: 'gotInterview',      header: 'Interview Invite?', width: 120, note: 'Yes once an interview/screen invite is detected in Gmail.' },
    { key: 'firstResponseAt',   header: 'First Response',    width: 110, type: 'DATE' },
    { key: 'interviewInviteAt', header: 'Invite Date',       width: 110, type: 'DATE' },
    { key: 'daysToResponse',    header: 'Days to Response',  width: 120, type: 'NUMBER' },
    { key: 'lastEmailAt',       header: 'Last Email',        width: 110, type: 'DATE' },
    { key: 'lastEmailSubject',  header: 'Last Email Subject',width: 260 },
    { key: 'threadUrl',         header: 'Gmail Thread',      width: 130, type: 'LINK' },
    { key: 'notes',             header: 'Notes',             width: 260 },
    { key: 'source',            header: 'Source',            width: 90,  note: 'auto = detected, manual = added by you.' },
    { key: 'updatedAt',         header: 'Updated',           width: 140, type: 'DATETIME' },
  ];
  C.COL_INDEX = Object.fromEntries(C.COLUMNS.map((c, i) => [c.key, i]));
  C.HEADERS = C.COLUMNS.map((c) => c.header);

  // ---------------------------------------------------------------------------
  // ATS / job board registry.
  //   hosts      — hostname suffixes that identify the board
  //   applyRe    — request URLs that mean "an application was just submitted"
  //   mailDomains— domains their transactional email comes from
  // ---------------------------------------------------------------------------
  C.BOARDS = [
    {
      id: 'greenhouse', label: 'Greenhouse',
      hosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'my.greenhouse.io', 'greenhouse.io'],
      applyRe: [/greenhouse\.io\/.*(applications?|job_app|job_application|application_form)/i, /api\.greenhouse\.io\/.*(applications?|boards)/i, /greenhouse\.io\/.*\/jobs\/\d+/i],
      mailDomains: ['greenhouse.io', 'us.greenhouse-mail.io', 'greenhouse-mail.io'],
    },
    {
      id: 'lever', label: 'Lever',
      hosts: ['jobs.lever.co', 'lever.co', 'hire.lever.co'],
      applyRe: [/api\.lever\.co\/v\d\/postings\/[^/]+\/[^/]+\/?(apply)?/i, /jobs\.lever\.co\/.*\/apply/i],
      mailDomains: ['lever.co', 'hire.lever.co', 'jobs.lever.co'],
    },
    {
      id: 'ashby', label: 'Ashby',
      hosts: ['jobs.ashbyhq.com', 'ashbyhq.com'],
      applyRe: [/ashbyhq\.com\/.*(applicationForm\.submit|application\/submit|submitApplication|non-user-graphql|apply)/i, /ashbyhq\.com\/api\//i],
      mailDomains: ['ashbyhq.com', 'mail.ashbyhq.com'],
    },
    {
      id: 'workday', label: 'Workday',
      hosts: ['myworkdayjobs.com', 'myworkdaysite.com', 'wd1.myworkdayjobs.com', 'wd5.myworkdayjobs.com'],
      applyRe: [/myworkday(jobs|site)\.com\/.*(submitApplication|\/submit|applyManually|quickApply)/i],
      mailDomains: ['myworkday.com', 'workday.com'],
    },
    {
      id: 'linkedin', label: 'LinkedIn',
      hosts: ['linkedin.com', 'www.linkedin.com'],
      applyRe: [/voyager\/api\/.*jobApplication/i, /voyager\/api\/voyagerJobsDashJobPostingApplication/i, /\/jobs\/api\/.*apply/i, /voyager\/api\/graphql.*[Aa]pply/],
      mailDomains: ['linkedin.com', 'e.linkedin.com', 'bounce.linkedin.com'],
    },
    {
      id: 'indeed', label: 'Indeed',
      hosts: ['indeed.com', 'apply.indeed.com', 'smartapply.indeed.com', 'm5.apply.indeed.com'],
      applyRe: [/apply\.indeed\.com\/.*(apply|submit)/i, /smartapply\.indeed\.com\/.*(submit|apply)/i, /indeed\.com\/applyjob/i],
      mailDomains: ['indeed.com', 'indeedemail.com', 'match.indeed.com'],
    },
    {
      id: 'smartrecruiters', label: 'SmartRecruiters',
      hosts: ['jobs.smartrecruiters.com', 'smartrecruiters.com', 'careers.smartrecruiters.com'],
      applyRe: [/smartrecruiters\.com\/.*\/(candidates|applications|apply)/i],
      mailDomains: ['smartrecruiters.com', 'smartrecruiters.net'],
    },
    {
      id: 'workable', label: 'Workable',
      hosts: ['apply.workable.com', 'workable.com', 'jobs.workable.com'],
      applyRe: [/workable\.com\/api\/.*(candidates|apply)/i, /apply\.workable\.com\/.*\/apply/i],
      mailDomains: ['workable.com', 'workablemail.com', 'hire.workable.com'],
    },
    {
      id: 'icims', label: 'iCIMS',
      hosts: ['icims.com', 'careers-icims.com'],
      applyRe: [/icims\.com\/.*(applyFlow|jobs\/\d+\/.*\/apply|submit)/i],
      mailDomains: ['icims.com', 'talent.icims.com'],
    },
    {
      id: 'taleo', label: 'Taleo',
      hosts: ['taleo.net', 'tbe.taleo.net'],
      applyRe: [/taleo\.net\/.*(applyFromLink|careersection.*apply|submitResume)/i],
      mailDomains: ['taleo.net', 'oraclecloud.com'],
    },
    {
      id: 'successfactors', label: 'SuccessFactors',
      hosts: ['successfactors.com', 'jobs.sap.com', 'career5.successfactors.eu'],
      applyRe: [/successfactors\.(com|eu)\/.*(apply|submit)/i],
      mailDomains: ['successfactors.com'],
    },
    {
      id: 'wellfound', label: 'Wellfound',
      hosts: ['wellfound.com', 'angel.co'],
      applyRe: [/wellfound\.com\/graphql/i, /wellfound\.com\/.*\/apply/i],
      mailDomains: ['wellfound.com', 'angel.co'],
    },
    {
      id: 'rippling', label: 'Rippling',
      hosts: ['ats.rippling.com', 'rippling.com'],
      applyRe: [/rippling\.com\/.*(apply|application)/i],
      mailDomains: ['rippling.com', 'ats.rippling.com'],
    },
    {
      id: 'dover', label: 'Dover',
      hosts: ['app.dover.com', 'dover.com', 'jobs.dover.com'],
      applyRe: [/dover\.(com|io)\/.*(apply|application)/i],
      mailDomains: ['dover.com', 'dover.io'],
    },
    {
      id: 'breezy', label: 'Breezy HR',
      hosts: ['breezy.hr', 'app.breezy.hr'],
      applyRe: [/breezy\.hr\/.*(apply|candidates)/i],
      mailDomains: ['breezy.hr'],
    },
    {
      id: 'jobvite', label: 'Jobvite',
      hosts: ['jobs.jobvite.com', 'jobvite.com', 'app.jobvite.com'],
      applyRe: [/jobvite\.com\/.*(apply|application)/i],
      mailDomains: ['jobvite.com'],
    },
    {
      id: 'bamboohr', label: 'BambooHR',
      hosts: ['bamboohr.com'],
      applyRe: [/bamboohr\.com\/.*(applications|apply)/i],
      mailDomains: ['bamboohr.com'],
    },
    {
      id: 'recruitee', label: 'Recruitee',
      hosts: ['recruitee.com'],
      applyRe: [/recruitee\.com\/.*(candidates|apply)/i],
      mailDomains: ['recruitee.com'],
    },
    {
      id: 'teamtailor', label: 'Teamtailor',
      hosts: ['teamtailor.com'],
      applyRe: [/teamtailor\.com\/.*(job-applications|apply)/i],
      mailDomains: ['teamtailor.com'],
    },
    {
      id: 'pinpoint', label: 'Pinpoint',
      hosts: ['pinpointhq.com'],
      applyRe: [/pinpointhq\.com\/.*(applications|apply)/i],
      mailDomains: ['pinpointhq.com'],
    },
    {
      id: 'polymer', label: 'Polymer',
      hosts: ['polymer.co'],
      applyRe: [/polymer\.co\/.*(apply|application)/i],
      mailDomains: ['polymer.co'],
    },
    {
      id: 'gem', label: 'Gem',
      hosts: ['jobs.gem.com', 'gem.com'],
      applyRe: [/gem\.com\/.*(apply|application)/i],
      mailDomains: ['gem.com'],
    },
    {
      id: 'ziprecruiter', label: 'ZipRecruiter',
      hosts: ['ziprecruiter.com'],
      applyRe: [/ziprecruiter\.com\/.*(apply|application)/i],
      mailDomains: ['ziprecruiter.com', 'ziprecruiter.net'],
    },
    {
      id: 'builtin', label: 'Built In',
      hosts: ['builtin.com', 'builtinnyc.com', 'builtinsf.com'],
      applyRe: [/builtin(nyc|sf|la|chicago|austin|boston|seattle|colorado)?\.com\/.*apply/i],
      mailDomains: ['builtin.com'],
    },
  ];

  // Any ATS/board mail domain — used to widen Gmail matching when the company
  // replies through their applicant tracking system rather than their own domain.
  C.ALL_ATS_MAIL_DOMAINS = Array.from(
    new Set(C.BOARDS.flatMap((b) => b.mailDomains))
  );

  // Generic apply-endpoint fallback for career sites running an unknown ATS.
  C.GENERIC_APPLY_RE = [
    /\/(job[-_]?)?applications?(\/|\?|$)/i,
    /\/apply(\/|\?|$)/i,
    /\/submit[-_]?application/i,
    /\/candidates?(\/|\?|$)/i,
    /graphql/i, // only ever matched together with a resume upload; see detector
  ];

  // Text that appears on an application-confirmation screen.
  C.SUCCESS_PATTERNS = [
    /application (has been |was )?(successfully )?(submitted|received|sent|completed)/i,
    /thank(s| you)[^.!]{0,40}(for )?(applying|your application|your interest)/i,
    /we(’|')?ve received your application/i,
    /we have received your application/i,
    /your application (is )?(now )?(complete|in|on its way)/i,
    /application complete/i,
    /applied on \w+/i,
    /you(’|')?ve applied/i,
    /your application was sent to/i,
    /submitted your application/i,
  ];

  // A URL an ATS sends you to *after* a successful submit. Greenhouse uses
  // /jobs/<id>/confirmation, Lever /thanks, Workable /applied, Indeed
  // /post-apply. This is the most reliable signal there is for flows that
  // navigate on submit, because it survives a full page load — unlike anything
  // held in memory, and unlike the submit request itself, which a native form
  // POST never exposes to fetch/XHR instrumentation.
  C.SUCCESS_URL_RE = /\/(confirmation|confirmed|thank[-_]?you|thanks|success|applied|post[-_]?apply|application[-_]?(complete|completed|received|submitted|confirmation))(\/|\?|#|$)/i;

  // Button labels that mean "this click submits an application".
  C.APPLY_BUTTON_RE = /^\s*(submit( my)?( the)?( job)?( application)?|send( my)?( the)?( application)?|apply( now| for this job| to this job)?|easy apply|submit and continue|finish( and submit)?|complete application)\s*$/i;

  C.RESUME_FILE_RE = /\.(pdf|docx?|rtf|txt|pages|odt)$/i;
  C.RESUME_HINT_RE = /(resume|résumé|cv|curriculum)/i;
  C.COVER_HINT_RE = /(cover[\s_-]?letter|motivation[\s_-]?letter)/i;

  root.JAT = root.JAT || {};
  root.JAT.C = C;
})(typeof globalThis !== 'undefined' ? globalThis : self);
