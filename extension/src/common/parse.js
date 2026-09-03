/**
 * Metadata extraction. Pure text parsers (salary/work-mode/funding) are usable
 * anywhere; the DOM extractors require a live `document`.
 */
(function (root) {
  const U = root.JAT && root.JAT.U;
  const C = root.JAT && root.JAT.C;
  const P = {};

  const clean = (s) => (U ? U.clean(s) : String(s || '').replace(/\s+/g, ' ').trim());

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------
  const CURRENCY_SYMBOLS = { '$': 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', '¥': 'JPY', 'C$': 'CAD', 'A$': 'AUD' };
  const MULTIPLIER = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };

  /** "$1.2M" -> 1200000, "45k" -> 45000, "150,000" -> 150000. */
  P.parseMoney = function (raw) {
    if (raw == null) return null;
    const s = String(raw).trim().replace(/[,\s]/g, '');
    const m = s.match(/^[^\d.-]*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]{1,8})?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    const suffix = (m[2] || '').toLowerCase();
    if (MULTIPLIER[suffix]) n *= MULTIPLIER[suffix];
    return n;
  };

  const PERIOD_FACTOR = { year: 1, annum: 1, yr: 1, annual: 1, month: 12, mo: 12, week: 52, wk: 52, day: 260, hour: 2080, hr: 2080 };

  function detectPeriod(text) {
    const m = String(text).match(/\b(?:per|a|\/)\s*(hour|hr|day|week|wk|month|mo|year|yr|annum)\b|\b(hourly|daily|weekly|monthly|annually|yearly|per annum)\b/i);
    if (!m) return null;
    const t = (m[1] || m[2] || '').toLowerCase();
    const map = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month', annually: 'year', yearly: 'year', 'per annum': 'year', annum: 'year' };
    return map[t] || t;
  }

  /**
   * Pull a compensation range out of free text.
   * Returns { min, max, currency, period, annualMin, annualMax, raw } or null.
   * Ranges are annualised into annualMin/annualMax so aggregates stay comparable;
   * `raw` always preserves exactly what the posting said.
   */
  P.parseSalary = function (text) {
    if (!text) return null;
    const t = clean(text);

    // Prefer a sentence that actually talks about pay, to avoid grabbing
    // "$50M raised" or "10,000 customers" from the boilerplate.
    const PAY_CUE = /(salary|compensation|base pay|base salary|pay range|comp range|pay rate|hourly rate|total cash|on-target earnings|ote|annual pay|wage)/i;
    const NUM = String.raw`(?:[$£€₹¥]|USD|GBP|EUR|CAD|AUD|INR)?\s?\d[\d,]*(?:\.\d+)?\s*(?:k|K|m|M)?`;
    const RANGE_RE = new RegExp(String.raw`(${NUM})\s*(?:-|–|—|to|up to|and)\s*(${NUM})`, 'g');

    const candidates = [];
    const sentences = t.split(/(?<=[.!?;])\s+/);
    for (const sent of sentences) {
      RANGE_RE.lastIndex = 0;
      let m;
      while ((m = RANGE_RE.exec(sent))) {
        const lo = P.parseMoney(m[1]);
        const hi = P.parseMoney(m[2]);
        if (lo == null || hi == null || hi < lo) continue;
        candidates.push({ lo, hi, sent, raw: m[0], cued: PAY_CUE.test(sent) });
      }
    }
    if (!candidates.length) {
      // Single figure, e.g. "Base salary: $185,000".
      const cue = PAY_CUE.source.replace('(', '(?:');
      const single = t.match(new RegExp(String.raw`${cue}[^.]{0,60}?(${NUM})`, 'i'));
      if (single) {
        const v = P.parseMoney(single[1]);
        if (v != null && v >= 1000) candidates.push({ lo: v, hi: v, sent: single[0], raw: single[0], cued: true });
      }
    }
    if (!candidates.length) return null;

    // Score: cued sentence wins; then plausible pay magnitude.
    const plausible = (v, period) => {
      if (period === 'hour') return v >= 8 && v <= 900;
      if (period === 'month') return v >= 800 && v <= 200000;
      return v >= 15000 && v <= 3000000;
    };
    let best = null;
    for (const c of candidates) {
      const period = detectPeriod(c.sent) || (c.hi <= 900 ? 'hour' : 'year');
      let score = 0;
      if (c.cued) score += 10;
      if (plausible(c.lo, period) && plausible(c.hi, period)) score += 6;
      if (c.hi > c.lo) score += 2;
      if (/\b(equity|option|bonus|401|revenue|raised|valuation|customers|users|arr)\b/i.test(c.sent)) score -= 5;
      if (score > (best ? best.score : -Infinity)) best = { ...c, period, score };
    }
    if (!best || best.score <= 0) return null;

    const curMatch = best.sent.match(/[$£€₹¥]|USD|GBP|EUR|CAD|AUD|INR/i);
    const symbol = curMatch ? curMatch[0] : '$';
    const currency = CURRENCY_SYMBOLS[symbol] || symbol.toUpperCase();
    const factor = PERIOD_FACTOR[best.period] || 1;

    return {
      min: best.lo,
      max: best.hi,
      currency,
      period: best.period,
      annualMin: Math.round(best.lo * factor),
      annualMax: Math.round(best.hi * factor),
      raw: clean(best.raw) + (best.period && best.period !== 'year' ? ` / ${best.period}` : ''),
    };
  };

  // ---------------------------------------------------------------------------
  // Work mode
  // ---------------------------------------------------------------------------
  P.parseWorkMode = function (text, hints) {
    const t = clean(text).toLowerCase();
    const h = clean(hints || '').toLowerCase();
    const all = h + ' \n ' + t;

    // Explicit, high-confidence phrases first.
    if (/\bhybrid\b/.test(all)) return C.WORK_MODE.HYBRID;
    if (/\b(\d\s*(days?|x)\s*(per|a|\/)\s*week\s*in\s*(the\s*)?office|in[- ]office\s*\d\s*days)/.test(all)) return C.WORK_MODE.HYBRID;
    if (/\b(fully|100%|entirely)?\s*remote\b/.test(all) && !/\bno(t|)\s+remote\b|\bremote\s+is\s+not\b/.test(all)) {
      if (/\bremote[- ]?(friendly|optional|first)\b/.test(all) && /\boffice\b/.test(all)) return C.WORK_MODE.HYBRID;
      return C.WORK_MODE.REMOTE;
    }
    if (/\b(telecommut|work from home|wfh|distributed team|anywhere in the (us|world|eu))\b/.test(all)) return C.WORK_MODE.REMOTE;
    if (/\b(on[- ]?site|in[- ]?person|in[- ]?office|onsite required|based in (our )?\w+ office)\b/.test(all)) return C.WORK_MODE.ONSITE;
    return C.WORK_MODE.UNKNOWN;
  };

  // ---------------------------------------------------------------------------
  // Funding / company stage
  // ---------------------------------------------------------------------------
  const STAGE_RE = /\b(pre[- ]?seed|seed(?:\s+stage)?|series\s+([a-j])\b(?:[-/]?\d)?|growth[- ]stage|late[- ]stage|early[- ]stage|publicly[- ]traded|public company|nasdaq|nyse|post[- ]ipo|ipo|bootstrapped|profitable|non[- ]?profit|nonprofit)\b/i;

  P.parseFunding = function (text) {
    const t = clean(text);
    const out = { stage: '', totalRaised: null, valuation: null, lastRound: '', lastRoundDate: '', headcount: '' };
    if (!t) return out;

    const stage = t.match(STAGE_RE);
    if (stage) {
      let s = clean(stage[0]);
      if (/^series/i.test(s)) s = 'Series ' + s.split(/\s+/)[1].toUpperCase();
      else if (/nasdaq|nyse|publicly|public company|post-?ipo|^ipo$/i.test(s)) s = 'Public';
      else s = s.replace(/\b\w/g, (m) => m.toUpperCase());
      out.stage = s;
      if (/^Series/.test(s)) out.lastRound = s;
    }

    const AMT = String.raw`\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|b|bn|thousand|million|billion|trillion)?`;

    const raised =
      t.match(new RegExp(String.raw`rais(?:ed|ing)\s+(?:over\s+|more than\s+|north of\s+|nearly\s+|a\s+)?${AMT}`, 'i')) ||
      t.match(new RegExp(String.raw`${AMT}\s+(?:in\s+)?(?:total\s+)?(?:funding|capital|financing)\s+(?:raised|to date)?`, 'i')) ||
      t.match(new RegExp(String.raw`(?:total\s+)?funding[:\s]+${AMT}`, 'i')) ||
      t.match(new RegExp(String.raw`backed by[^.]{0,80}?with\s+${AMT}`, 'i'));
    if (raised) {
      const v = P.parseMoney(`${raised[1]}${raised[2] || ''}`);
      if (v != null && v >= 10000) out.totalRaised = v;
    }

    const val =
      t.match(new RegExp(String.raw`valu(?:ation|ed)\s+(?:of\s+|at\s+)?${AMT}`, 'i')) ||
      t.match(new RegExp(String.raw`${AMT}\s+valuation`, 'i')) ||
      t.match(new RegExp(String.raw`market\s+cap(?:italization)?\s+(?:of\s+)?${AMT}`, 'i'));
    if (val) {
      const v = P.parseMoney(`${val[1]}${val[2] || ''}`);
      if (v != null && v >= 100000) out.valuation = v;
    }

    const round = t.match(/\b(pre[- ]?seed|seed|series\s+[a-j])\s+(?:round|funding|financing)?[^.]{0,40}?\b(?:in\s+)?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+)?(20\d{2})\b/i);
    if (round) {
      out.lastRound = clean(round[1]).replace(/\b\w/g, (m) => m.toUpperCase());
      out.lastRoundDate = clean((round[2] || '') + round[3]);
    }

    const head =
      t.match(/\b(\d{1,3}(?:,\d{3})*|\d+)\s*[-–]\s*(\d{1,3}(?:,\d{3})*|\d+)\s*(?:employees|people|person)\b/i) ||
      t.match(/\b(?:team of|we(?:'| a)re|company of|about|over|nearly)\s+(\d{1,3}(?:,\d{3})*)\s*(?:employees|people|person team|teammates|folks)\b/i) ||
      t.match(/\b(\d{1,3}(?:,\d{3})*)\+?\s*(?:employees|people)\b/i);
    if (head) out.headcount = head[2] ? `${head[1]}-${head[2]}` : head[1];

    return out;
  };

  // ---------------------------------------------------------------------------
  // JSON-LD
  // ---------------------------------------------------------------------------
  P.extractJsonLd = function (doc) {
    const results = [];
    const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      let data;
      try { data = JSON.parse(n.textContent.trim()); } catch { continue; }
      const queue = Array.isArray(data) ? data.slice() : [data];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
        const type = item['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes('JobPosting')) results.push(item);
      }
    }
    return results;
  };

  function addressToString(loc) {
    const locs = Array.isArray(loc) ? loc : [loc];
    const parts = [];
    for (const l of locs) {
      if (!l) continue;
      if (typeof l === 'string') { parts.push(l); continue; }
      const a = l.address || l;
      const bits = [a.addressLocality, a.addressRegion, a.addressCountry]
        .map((x) => (typeof x === 'object' && x ? x.name || x['@id'] : x))
        .filter(Boolean);
      if (bits.length) parts.push(bits.join(', '));
      else if (a.name) parts.push(a.name);
    }
    return Array.from(new Set(parts.map(clean).filter(Boolean))).slice(0, 3).join(' | ');
  }

  /** Map a schema.org JobPosting onto our record shape. */
  P.fromJsonLd = function (jp) {
    if (!jp) return {};
    const out = {};
    if (jp.title) out.position = clean(jp.title);
    const org = jp.hiringOrganization;
    if (org) {
      if (typeof org === 'string') out.company = clean(org);
      else {
        if (org.name) out.company = clean(org.name);
        const site = org.sameAs || org.url || (org.logo && (org.logo.url || org.logo));
        if (site && typeof site === 'string' && /^https?:/i.test(site)) {
          out.companyDomain = U.rootDomain(site);
        }
      }
    }
    if (jp.jobLocation) out.location = addressToString(jp.jobLocation);
    if (jp.applicantLocationRequirements && !out.location) out.location = addressToString(jp.applicantLocationRequirements);
    if (jp.jobLocationType && /TELECOMMUTE/i.test(String(jp.jobLocationType))) out.workMode = C.WORK_MODE.REMOTE;
    if (jp.industry) out.industry = clean(Array.isArray(jp.industry) ? jp.industry.join(', ') : jp.industry);
    if (jp.datePosted) out.datePosted = clean(jp.datePosted);
    if (jp.employmentType) {
      const et = Array.isArray(jp.employmentType) ? jp.employmentType.join(', ') : jp.employmentType;
      out.employmentType = clean(String(et)).replace(/_/g, ' ');
    }

    const bs = jp.baseSalary || jp.estimatedSalary;
    if (bs) {
      const cur = bs.currency || bs.salaryCurrency || 'USD';
      const val = bs.value || bs;
      const min = P.parseMoney(val.minValue != null ? val.minValue : val.value);
      const max = P.parseMoney(val.maxValue != null ? val.maxValue : val.value);
      const unit = String(val.unitText || val.unitCode || 'YEAR').toLowerCase();
      const factor = /hour/.test(unit) ? 2080 : /day/.test(unit) ? 260 : /week/.test(unit) ? 52 : /month/.test(unit) ? 12 : 1;
      if (min != null || max != null) {
        out.salaryMin = min != null ? Math.round(min * factor) : null;
        out.salaryMax = max != null ? Math.round(max * factor) : (min != null ? Math.round(min * factor) : null);
        const fmt = (n) => (n == null ? '' : n.toLocaleString('en-US'));
        out.salaryRaw = `${cur} ${fmt(min)}${max != null && max !== min ? '–' + fmt(max) : ''}${factor !== 1 ? ' / ' + unit : ''}`.trim();
        out.salaryCurrency = cur;
      }
    }
    return out;
  };

  // ---------------------------------------------------------------------------
  // Whole-page extraction
  // ---------------------------------------------------------------------------
  const META = (doc, sel, attr) => {
    const el = doc.querySelector(sel);
    return el ? clean(el.getAttribute(attr || 'content')) : '';
  };

  /** Visible text of the page, capped so regex work stays cheap. */
  P.pageText = function (doc, cap) {
    const body = doc.body;
    if (!body) return '';
    const clone = body.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,iframe').forEach((n) => n.remove());
    return clean(clone.innerText || clone.textContent || '').slice(0, cap || 60000);
  };

  /**
   * Best-effort company website domain, so Gmail matching has something
   * stronger than a name to work with.
   */
  P.guessCompanyDomain = function (doc, url, companyName) {
    const host = U.hostOf(url);
    const isAts = C.BOARDS.some((b) => b.hosts.some((h) => host === h || host.endsWith('.' + h)));
    if (!isAts && host && !/^(www\.)?(google|linkedin|indeed|glassdoor|ziprecruiter|builtin)\./.test(host)) {
      return U.rootDomain(host);
    }
    const jp = P.extractJsonLd(doc)[0];
    const fromLd = jp ? P.fromJsonLd(jp).companyDomain : '';
    if (fromLd) return fromLd;

    const norm = U.normCompany(companyName || '');
    const candidates = new Map();
    const consider = (raw, weight) => {
      if (!raw || !/^https?:/i.test(raw)) return;
      const d = U.rootDomain(raw);
      if (!d) return;
      if (C.BOARDS.some((b) => b.mailDomains.includes(d) || b.hosts.some((h) => h.endsWith(d)))) return;
      if (/^(google|gstatic|googleapis|cloudfront|amazonaws|facebook|twitter|x|linkedin|instagram|youtube|github|glassdoor|crunchbase|wikipedia|medium|notion|typeform|calendly)\.\w+/.test(d)) return;
      let w = weight;
      if (norm && U.slug(d.split('.')[0]).replace(/ /g, '') === norm.replace(/ /g, '')) w += 20;
      candidates.set(d, (candidates.get(d) || 0) + w);
    };

    consider(META(doc, 'meta[property="og:url"]'), 3);
    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical) consider(canonical.href, 3);
    doc.querySelectorAll('a[href^="http"]').forEach((a, i) => { if (i < 400) consider(a.href, 1); });
    doc.querySelectorAll('img[src^="http"]').forEach((im, i) => { if (i < 60) consider(im.src, 2); });

    let bestDomain = '', bestScore = 0;
    for (const [d, s] of candidates) if (s > bestScore) { bestScore = s; bestDomain = d; }
    return bestScore >= 3 ? bestDomain : '';
  };

  /** Identify which board/ATS a URL belongs to. */
  P.boardFor = function (url) {
    const host = U.hostOf(url);
    for (const b of C.BOARDS) {
      if (b.hosts.some((h) => host === h || host.endsWith('.' + h))) return b;
    }
    return null;
  };

  /**
   * Everything we can learn about a job from its page, merged newest-wins:
   * JSON-LD > board adapter > meta tags > free-text heuristics.
   */
  P.extractPageMeta = function (doc, url, adapterResult) {
    const text = P.pageText(doc);
    const board = P.boardFor(url);
    const rec = {
      jdUrl: url,
      board: board ? board.label : (U.hostOf(url) || ''),
      boardId: board ? board.id : 'other',
    };

    // 3rd priority: meta tags + title.
    const ogTitle = META(doc, 'meta[property="og:title"]') || clean(doc.title);
    const ogSite = META(doc, 'meta[property="og:site_name"]');
    if (ogTitle) {
      const parts = ogTitle.split(/\s+[-|–—@]\s+/).map(clean).filter(Boolean);
      if (parts.length >= 2) {
        rec.position = parts[0];
        rec.company = parts[parts.length - 1].replace(/\b(careers?|jobs?|hiring)\b/gi, '').trim() || parts[1];
      } else {
        rec.position = ogTitle;
      }
    }
    if (ogSite && !/greenhouse|lever|ashby|workday|linkedin|indeed|workable|smartrecruiters/i.test(ogSite)) {
      rec.company = ogSite;
    }
    const ogDesc = META(doc, 'meta[property="og:description"]') || META(doc, 'meta[name="description"]');

    // 2nd priority: board-specific adapter.
    if (adapterResult) Object.assign(rec, prune(adapterResult));

    // 1st priority: JSON-LD.
    const jps = P.extractJsonLd(doc);
    if (jps.length) Object.assign(rec, prune(P.fromJsonLd(jps[0])));

    // Fill gaps from free text.
    const salaryText = [rec.salaryRaw, ogDesc, text].filter(Boolean).join('\n');
    if (rec.salaryMin == null && rec.salaryMax == null) {
      const sal = P.parseSalary(salaryText);
      if (sal) {
        rec.salaryMin = sal.annualMin;
        rec.salaryMax = sal.annualMax;
        rec.salaryRaw = sal.raw;
        rec.salaryCurrency = sal.currency;
      }
    }
    if (!rec.workMode) {
      rec.workMode = P.parseWorkMode(text, [rec.position, rec.location, ogDesc].filter(Boolean).join(' '));
    }

    const funding = P.parseFunding(text);
    for (const k of ['stage', 'totalRaised', 'valuation', 'lastRound', 'lastRoundDate', 'headcount']) {
      const target = k === 'stage' ? 'companyStage' : k;
      if (!rec[target] && funding[k]) rec[target] = funding[k];
    }

    if (!rec.companyDomain) rec.companyDomain = P.guessCompanyDomain(doc, url, rec.company);
    if (rec.company) rec.company = clean(rec.company).replace(/\s*[-|–—]\s*(careers?|jobs?)\s*$/i, '');
    if (rec.position) rec.position = clean(rec.position).replace(/\s*[-|–—]\s*(apply|application)\s*$/i, '');

    return rec;
  };

  function prune(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v !== '' && v !== null && v !== undefined) out[k] = v;
    }
    return out;
  }
  P.prune = prune;

  root.JAT = root.JAT || {};
  root.JAT.P = P;
})(typeof globalThis !== 'undefined' ? globalThis : self);
