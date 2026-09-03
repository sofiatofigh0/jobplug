/**
 * Board-specific DOM readers.
 *
 * These are a *fallback layer*: JSON-LD wins when a site publishes it (most
 * Greenhouse/Lever/Ashby boards do). Adapters exist for the sites that don't,
 * and to recover fields JSON-LD routinely omits — work mode and company slug.
 */
(function (root) {
  const U = root.JAT.U;
  const C = root.JAT.C;
  const clean = U.clean;

  /** First non-empty text match from a list of selectors. */
  function pick(doc, selectors, attr) {
    for (const sel of selectors) {
      let el;
      try { el = doc.querySelector(sel); } catch { continue; }
      if (!el) continue;
      const v = clean(attr ? el.getAttribute(attr) : (el.innerText || el.textContent));
      if (v) return v;
    }
    return '';
  }

  function pickAll(doc, selectors) {
    const out = [];
    for (const sel of selectors) {
      let els;
      try { els = doc.querySelectorAll(sel); } catch { continue; }
      els.forEach((el) => { const v = clean(el.innerText || el.textContent); if (v) out.push(v); });
    }
    return Array.from(new Set(out));
  }

  /** Turn a URL path slug into a presentable company name. */
  function slugToName(slug) {
    if (!slug) return '';
    return clean(
      slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
    );
  }

  function pathSeg(url, i) {
    try {
      const segs = new URL(url).pathname.split('/').filter(Boolean);
      return segs[i] || '';
    } catch { return ''; }
  }

  /** Free-text scan restricted to the header/summary area of a posting. */
  function headerText(doc, selectors) {
    const bits = [];
    for (const sel of selectors) {
      let el;
      try { el = doc.querySelector(sel); } catch { continue; }
      if (el) bits.push(clean(el.innerText || el.textContent).slice(0, 1500));
    }
    return bits.join(' \n ');
  }

  const ADAPTERS = {
    greenhouse(doc, url) {
      const host = U.hostOf(url);
      let slug = '';
      if (/greenhouse\.io$/.test(host)) slug = pathSeg(url, 0) === 'embed' ? '' : pathSeg(url, 0);
      return {
        position: pick(doc, ['h1.app-title', '.job__title h1', '.job__title', '[class*="job__title"] h1', 'h1']),
        company: pick(doc, ['.company-name', '#header .company-name', '[class*="company-name"]']).replace(/^at\s+/i, '') || slugToName(slug),
        location: pick(doc, ['.location', '.job__location', '[class*="job__location"]', 'div.location']),
        _headerText: headerText(doc, ['#header', '.app-title', '.job__location', '#content']),
      };
    },

    lever(doc, url) {
      const slug = pathSeg(url, 0);
      const cats = pickAll(doc, ['.posting-categories .posting-category', '.posting-categories div', '[class*="posting-category"]']);
      const location = cats.find((c) => !/^(full|part)[- ]time$/i.test(c) && !/^(remote|hybrid|onsite)$/i.test(c)) || cats[0] || '';
      const workMode = cats.find((c) => /^(remote|hybrid|on-?site)$/i.test(c)) || '';
      return {
        position: pick(doc, ['.posting-headline h2', '[data-qa="posting-name"]', 'h2']),
        company: pick(doc, ['.main-header-logo img', '.main-header-content img'], 'alt') || slugToName(slug),
        location,
        workMode: workMode ? clean(workMode).replace(/^on-?site$/i, 'Onsite').replace(/\b\w/g, (m) => m.toUpperCase()) : '',
        _headerText: headerText(doc, ['.posting-headline', '.posting-categories']),
      };
    },

    ashby(doc, url) {
      const slug = pathSeg(url, 0);
      return {
        position: pick(doc, ['h1', '[class*="_title_"]', '[class*="jobPostingHeader"] h1']),
        company: pick(doc, ['[class*="companyName"]', 'header img'], 'alt') || slugToName(slug),
        location: pick(doc, ['[class*="_details_"] p', '[class*="location"]', '[class*="_jobPostingHeaderDetail"]']),
        _headerText: headerText(doc, ['header', '[class*="jobPostingHeader"]', '[class*="_details_"]']),
      };
    },

    workday(doc, url) {
      const host = U.hostOf(url);
      const sub = host.split('.')[0].replace(/^wd\d+$/, '');
      return {
        position: pick(doc, ['[data-automation-id="jobPostingHeader"]', 'h1[data-automation-id]', 'h2[data-automation-id="jobPostingHeader"]', 'h1']),
        company: pick(doc, ['[data-automation-id="company"]', 'header img'], 'alt') || slugToName(sub && sub !== 'www' ? sub : pathSeg(url, 0)),
        location: pick(doc, ['[data-automation-id="locations"]', '[data-automation-id="jobPostingLocation"]', 'dd[data-automation-id="locations"]']),
        _headerText: headerText(doc, ['[data-automation-id="jobPostingHeader"]', '[data-automation-id="locations"]', '[data-automation-id="jobPostingDescription"]']),
      };
    },

    linkedin(doc) {
      const primary = pick(doc, [
        '.job-details-jobs-unified-top-card__primary-description-container',
        '.jobs-unified-top-card__primary-description',
        '.topcard__flavor-row',
      ]);
      const prefs = pickAll(doc, [
        '.job-details-jobs-unified-top-card__job-insight span',
        '.jobs-unified-top-card__workplace-type',
        '.job-details-fit-level-preferences button span',
        '[class*="job-insight"] span',
      ]).join(' ');
      return {
        position: pick(doc, [
          '.job-details-jobs-unified-top-card__job-title h1',
          '.job-details-jobs-unified-top-card__job-title',
          '.jobs-unified-top-card__job-title',
          '.topcard__title', 'h1',
        ]),
        company: pick(doc, [
          '.job-details-jobs-unified-top-card__company-name a',
          '.job-details-jobs-unified-top-card__company-name',
          '.jobs-unified-top-card__company-name',
          '.topcard__org-name-link',
        ]),
        location: clean(primary.split('·')[1] || primary),
        _headerText: [primary, prefs].join(' \n '),
      };
    },

    indeed(doc) {
      return {
        position: pick(doc, ['.jobsearch-JobInfoHeader-title', '[data-testid="jobsearch-JobInfoHeader-title"]', 'h1.jobsearch-JobInfoHeader-title', 'h1']),
        company: pick(doc, ['[data-testid="inlineHeader-companyName"] a', '[data-testid="inlineHeader-companyName"]', '[data-company-name]', '.jobsearch-CompanyInfoContainer a']),
        location: pick(doc, ['[data-testid="job-location"]', '[data-testid="inlineHeader-companyLocation"]', '.jobsearch-JobInfoHeader-subtitle div:last-child']),
        salaryRaw: pick(doc, ['#salaryInfoAndJobType', '[data-testid="attribute_snippet_testid"]', '.salary-snippet-container']),
        _headerText: headerText(doc, ['.jobsearch-JobInfoHeader-subtitle', '#salaryInfoAndJobType', '#jobDetailsSection', '.jobsearch-JobComponent-description']),
      };
    },

    smartrecruiters(doc, url) {
      return {
        position: pick(doc, ['h1.job-title', '[itemprop="title"]', 'h1']),
        company: pick(doc, ['[itemprop="hiringOrganization"] [itemprop="name"]', '.company-name', 'a.link--company']) || slugToName(pathSeg(url, 0)),
        location: pick(doc, ['.job-location', '[itemprop="jobLocation"]', 'spl-job-location']),
        _headerText: headerText(doc, ['.job-sections', '#st-jobDescription', 'header']),
      };
    },

    workable(doc, url) {
      return {
        position: pick(doc, ['[data-ui="job-title"]', 'h1']),
        company: pick(doc, ['[data-ui="company-name"]', '[data-ui="header-company-name"]', 'header img'], 'alt') || slugToName(pathSeg(url, 0)),
        location: pick(doc, ['[data-ui="job-location"]', '[data-ui="job-workplace"]']),
        workMode: (function () {
          const w = pick(doc, ['[data-ui="job-workplace"]', '[data-ui="job-remote"]']);
          return /remote/i.test(w) ? C.WORK_MODE.REMOTE : /hybrid/i.test(w) ? C.WORK_MODE.HYBRID : /on-?site/i.test(w) ? C.WORK_MODE.ONSITE : '';
        })(),
        _headerText: headerText(doc, ['[data-ui="job-description"]', 'header', '[data-ui="overview"]']),
      };
    },

    wellfound(doc, url) {
      // Wellfound is the one board that publishes funding data next to the job.
      const text = headerText(doc, [
        '[class*="styles_component"]', '[data-test="StartupHeader"]',
        '[class*="company-details"]', 'main',
      ]);
      return {
        position: pick(doc, ['[class*="job-title"]', 'h1', '[data-test="JobTitle"]']),
        company: pick(doc, ['[data-test="StartupHeader-name"]', '[class*="startup-link"]', 'h2 a']) || slugToName(pathSeg(url, 1)),
        location: pick(doc, ['[class*="location"]', '[data-test="JobLocation"]']),
        _headerText: text,
      };
    },

    icims(doc) {
      return {
        position: pick(doc, ['.iCIMS_Header h1', '#position-title', 'h1.iCIMS_Header', 'h1']),
        company: pick(doc, ['.iCIMS_Logo img', '#company-name'], 'alt'),
        location: pick(doc, ['.header .location', '[class*="JobLocation"]', '#job-location']),
        _headerText: headerText(doc, ['.iCIMS_JobContent', '#job-description', '.iCIMS_InfoMsg']),
      };
    },

    generic(doc) {
      return {
        position: pick(doc, ['h1', '[class*="job-title"]', '[class*="jobTitle"]', '[id*="job-title"]']),
        location: pick(doc, ['[class*="job-location"]', '[class*="jobLocation"]', '[itemprop="jobLocation"]', '[class*="location"]']),
        _headerText: headerText(doc, ['main', 'article', '[class*="job"]', 'body']),
      };
    },
  };

  /** Run the adapter for this URL and return a pruned partial record. */
  function run(doc, url) {
    const board = root.JAT.P.boardFor(url);
    const fn = (board && ADAPTERS[board.id]) || ADAPTERS.generic;
    let res;
    try { res = fn(doc, url) || {}; } catch { res = {}; }

    // Let the header blob feed the work-mode / funding heuristics, then drop it.
    const header = res._headerText || '';
    delete res._headerText;
    if (!res.workMode && header) {
      const wm = root.JAT.P.parseWorkMode(header, [res.position, res.location].filter(Boolean).join(' '));
      if (wm) res.workMode = wm;
    }
    if (header) {
      const f = root.JAT.P.parseFunding(header);
      if (f.stage) res.companyStage = f.stage;
      if (f.totalRaised) res.totalRaised = f.totalRaised;
      if (f.valuation) res.valuation = f.valuation;
      if (f.headcount) res.headcount = f.headcount;
    }
    if (!res.salaryRaw && header) {
      const s = root.JAT.P.parseSalary(header);
      if (s) { res.salaryMin = s.annualMin; res.salaryMax = s.annualMax; res.salaryRaw = s.raw; }
    }
    return root.JAT.P.prune(res);
  }

  root.JAT.A = { run, pick, pickAll, slugToName, pathSeg };
})(typeof globalThis !== 'undefined' ? globalThis : self);
