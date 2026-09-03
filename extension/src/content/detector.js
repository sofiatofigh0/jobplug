/**
 * Isolated-world detector.
 *
 * Applying to a job has no standard signal, so we accumulate weighted evidence
 * from four independent channels and fire once the total clears a threshold:
 *
 *   1. network  — a successful POST to an apply endpoint      (strongest)
 *   2. file     — a resume-looking file was attached
 *   3. intent   — a button whose label means "submit application" was clicked
 *   4. outcome  — confirmation copy appeared on screen
 *
 * Any single channel is noisy; the combination is not. Everything is scoped to
 * one page-visit and reset on navigation.
 */
(function (root) {
  const { U, C, P, A } = root.JAT;
  const TAG = '__JAT_NET__';

  const WEIGHTS = { boardApply: 60, genericApplyWithFile: 60, genericApply: 25, atsPost: 45, file: 25, click: 20, success: 50, atsHost: 10 };
  const THRESHOLD = 60;
  const REARM_MS = 90_000;

  const onAtsHost = !!P.boardFor(location.href);

  let lastFiredKey = '';
  let lastFiredAt = 0;
  let successObserver = null;

  function newState() {
    const st = {
      url: location.href,
      score: 0,
      reasons: [],
      resume: null,        // { name, size, type, field, label }
      coverLetter: null,
      netUrl: '',
      armedAt: 0,
      fired: false,
      postOnAts: false,
    };
    // Re-applied on every reset. Previously this was added once at load, so any
    // reset silently dropped it and every later score was 10 short.
    if (onAtsHost) { st.score += WEIGHTS.atsHost; st.reasons.push('atsHost'); }
    return st;
  }

  const state = restore() || newState();

  /**
   * Soft reset: keep what the user has already done in this flow.
   *
   * An apply flow routinely rewrites the URL — step params, a hash, a redirect
   * to a confirmation page. Wiping the resume upload on every one of those was
   * why multi-step Ashby and Greenhouse applications were never detected: by
   * the time the submit fired, the evidence had been thrown away.
   */
  function reset({ hard = false } = {}) {
    const carry = hard ? {} : { resume: state.resume, coverLetter: state.coverLetter };
    Object.assign(state, newState());
    for (const [k, v] of Object.entries(carry)) if (v) state[k] = v;
    if (state.resume) { state.score += WEIGHTS.file; state.reasons.push('file.carried'); }
    if (successObserver) { successObserver.disconnect(); successObserver = null; }
    persist();
  }

  // ---------------------------------------------------------------------------
  // Evidence has to outlive a full page load: plenty of ATS flows POST the form
  // and land on a freshly loaded confirmation page, which would otherwise start
  // from zero with no memory of the resume that was just uploaded.
  // ---------------------------------------------------------------------------
  const STORE_KEY = '__jat_evidence__';
  const CARRY_MS = 10 * 60_000;

  function persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        at: Date.now(),
        origin: location.origin,
        resume: state.resume,
        coverLetter: state.coverLetter,
      }));
    } catch (_) { /* storage disabled or full — detection just loses its memory */ }
  }

  function restore() {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || saved.origin !== location.origin || Date.now() - saved.at > CARRY_MS) return null;
      const st = newState();
      if (saved.resume) {
        st.resume = saved.resume;
        st.score += WEIGHTS.file;
        st.reasons.push('file.restored');
      }
      if (saved.coverLetter) st.coverLetter = saved.coverLetter;
      return st;
    } catch { return null; }
  }

  function addEvidence(kind, weight, detail) {
    if (state.fired) return;
    state.score += weight;
    state.reasons.push(detail ? `${kind}(${detail})` : kind);
    if (state.score >= WEIGHTS.file && !successObserver) armSuccessObserver();
    maybeFire();
    scheduleNearMiss();
  }


  // ---------------------------------------------------------------------------
  // Channel 1 + 2: messages from the MAIN-world hook
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d[TAG] !== true) return;

    if (d.kind === 'file') {
      absorbFiles(d.files);
      return;
    }
    if (d.kind !== 'net') return;

    if (d.files && d.files.length) absorbFiles(d.files);
    if (!d.ok) return;

    const board = P.boardFor(d.url) || P.boardFor(location.href);
    const boardMatch = board && (board.applyRe || []).some((re) => re.test(d.url));
    if (boardMatch) {
      state.netUrl = d.url;
      addEvidence('net.board', WEIGHTS.boardApply, board.id);
      return;
    }
    const hasResume = !!state.resume || (d.files || []).some((f) => C.RESUME_FILE_RE.test(f.name || ''));

    if (C.GENERIC_APPLY_RE.some((re) => re.test(d.url))) {
      // A bare /apply POST is common on marketing sites; require a resume
      // alongside it before treating it as a real submission.
      state.netUrl = d.url;
      addEvidence(hasResume ? 'net.generic+file' : 'net.generic',
        hasResume ? WEIGHTS.genericApplyWithFile : WEIGHTS.genericApply, U.hostOf(d.url));
      return;
    }

    // Endpoint-shape fallback. Every ATS reworks its submit URL sooner or later,
    // and a regex that has rotted fails silently — the application just never
    // gets logged. So: once a resume has been attached, a successful write
    // request on an ATS host is treated as evidence in its own right, whatever
    // the URL happens to look like. Counted once per flow.
    if (onAtsHost && hasResume && !state.postOnAts) {
      state.postOnAts = true;
      state.netUrl = d.url;
      addEvidence('net.atsPost', WEIGHTS.atsPost, U.hostOf(d.url));
    }
  });

  function absorbFiles(files) {
    for (const f of files || []) {
      const name = U.clean(f.name || '');
      if (!name) continue;
      const hay = `${name} ${f.field || ''} ${f.label || ''}`;
      const isDoc = C.RESUME_FILE_RE.test(name);
      if (!isDoc) continue;

      if (C.COVER_HINT_RE.test(hay) && !C.RESUME_HINT_RE.test(name)) {
        if (!state.coverLetter) { state.coverLetter = { name }; addEvidence('file.cover', 5, name); }
        continue;
      }
      if (!state.resume || (C.RESUME_HINT_RE.test(name) && !C.RESUME_HINT_RE.test(state.resume.name))) {
        state.resume = { name, size: f.size || 0, type: f.type || '', field: f.field || '', label: f.label || '' };
        persist();
        addEvidence('file.resume', WEIGHTS.file, name);
      }
    }
  }

  // Drag-and-drop uploads never hit an <input type=file> change event.
  document.addEventListener('drop', (e) => {
    try {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      absorbFiles(Array.from(files).map((f) => ({ name: f.name, size: f.size, type: f.type, field: 'drop' })));
    } catch (_) {}
  }, true);

  // ---------------------------------------------------------------------------
  // Channel 3: submit intent
  // ---------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    try {
      const el = e.target && e.target.closest && e.target.closest('button, input[type=submit], a[role=button], [role=button], div[class*="submit"]');
      if (!el) return;
      const label = U.clean(el.innerText || el.value || el.getAttribute('aria-label') || '');
      if (!label || label.length > 40) return;
      if (!C.APPLY_BUTTON_RE.test(label)) return;
      // "Apply" on a listing page just opens the form — only count it as intent
      // when a resume is already attached or we're inside an ATS flow.
      const strong = !!state.resume || onAtsHost || /submit|send|finish|complete/i.test(label);
      if (!strong) return;
      addEvidence('click', WEIGHTS.click, label.slice(0, 30));
    } catch (_) {}
  }, true);

  document.addEventListener('submit', (e) => {
    try {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      const hasFile = form.querySelector('input[type=file]');
      const action = U.clean(form.getAttribute('action') || location.href);
      const looksApply = C.GENERIC_APPLY_RE.some((re) => re.test(action)) || onAtsHost;
      if (!hasFile && !looksApply) return;
      if (hasFile && hasFile.files && hasFile.files.length) {
        absorbFiles(Array.from(hasFile.files).map((f) => ({ name: f.name, size: f.size, type: f.type, field: hasFile.name })));
      }
      addEvidence('formSubmit', looksApply ? 45 : 20, U.hostOf(action));
    } catch (_) {}
  }, true);

  // ---------------------------------------------------------------------------
  // Channel 4: confirmation copy on screen
  // ---------------------------------------------------------------------------
  function armSuccessObserver() {
    if (successObserver) return;
    if (!document.body) {
      // Evidence can arrive before <body> exists at document_start.
      document.addEventListener('DOMContentLoaded', armSuccessObserver, { once: true });
      return;
    }
    state.armedAt = Date.now();
    const check = () => {
      if (state.fired) return;
      const text = (document.body.innerText || '').slice(0, 20000);
      for (const re of C.SUCCESS_PATTERNS) {
        if (re.test(text)) { addEvidence('successText', WEIGHTS.success, re.source.slice(0, 24)); return; }
      }
    };
    check();
    successObserver = new MutationObserver(debounce(check, 400));
    try {
      successObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (_) {}
    setTimeout(() => { if (successObserver) { successObserver.disconnect(); successObserver = null; } }, 120_000);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ---------------------------------------------------------------------------
  // Firing
  // ---------------------------------------------------------------------------
  function maybeFire() {
    if (state.fired || state.score < THRESHOLD) return;
    const meta = collect();
    if (!meta.company && !meta.position) return; // nothing worth writing down

    const key = dedupeKey(meta);
    if (key === lastFiredKey && Date.now() - lastFiredAt < REARM_MS) return;

    state.fired = true;
    lastFiredKey = key;
    lastFiredAt = Date.now();

    clearTimeout(nearMissTimer);
    send('CAPTURE', {
      record: meta,
      evidence: { score: state.score, reasons: state.reasons.slice(0, 12), netUrl: state.netUrl },
    });
    send('DETECT_LOG', {
      entry: {
        at: Date.now(), outcome: 'captured', url: location.href, host: U.hostOf(location.href),
        board: meta.board || '', company: meta.company || '', position: meta.position || '',
        score: state.score, threshold: THRESHOLD, reasons: state.reasons.slice(0, 12),
        resume: meta.resumeName || '',
      },
    });
    // Allow a second, distinct application in the same tab later on.
    setTimeout(() => { if (state.fired) reset(); }, REARM_MS);
  }

  /**
   * Report what was seen but did not add up.
   *
   * A missed application is otherwise silent — nothing appears anywhere, and
   * there is no way to tell "the detector saw nothing" apart from "it saw a
   * resume and a click but never a submit". Both need different fixes, so the
   * near miss gets recorded with its evidence.
   */
  let nearMissTimer = null;
  function scheduleNearMiss() {
    clearTimeout(nearMissTimer);
    if (state.fired || state.score <= 0) return;
    nearMissTimer = setTimeout(() => {
      if (state.fired || state.score >= THRESHOLD) return;
      let meta = {};
      try { meta = P.extractPageMeta(document, location.href, A.run(document, location.href)); } catch (_) {}
      send('DETECT_LOG', {
        entry: {
          at: Date.now(),
          outcome: 'near-miss',
          url: location.href,
          host: U.hostOf(location.href),
          board: meta.board || '',
          company: meta.company || '',
          position: meta.position || '',
          score: state.score,
          threshold: THRESHOLD,
          reasons: state.reasons.slice(0, 12),
          resume: state.resume ? state.resume.name : '',
        },
      });
    }, 15_000);
  }

  function dedupeKey(m) {
    return [U.normCompany(m.company || ''), U.normTitle(m.position || ''), m.boardId || ''].join('|');
  }

  /** Build the record: page metadata + this visit's evidence. */
  function collect() {
    let meta = {};
    try { meta = P.extractPageMeta(document, location.href, A.run(document, location.href)); } catch (_) { meta = { jdUrl: location.href }; }

    if (state.resume) {
      meta.resumeName = state.resume.name;
      meta.resumeSize = state.resume.size;
    } else {
      const chosen = chosenResumeLabel();
      if (chosen) meta.resumeName = chosen;
    }
    if (state.coverLetter) meta.coverLetter = state.coverLetter.name;

    meta.appliedAt = new Date().toISOString();
    meta.source = 'auto';
    meta.isFrame = window.top !== window;
    meta.frameUrl = location.href;
    if (meta.isFrame && document.referrer) meta.parentUrl = document.referrer;
    return P.prune(meta);
  }

  /**
   * LinkedIn Easy Apply (and a few others) reuse a stored resume rather than a
   * file input, so the only trace of which one you sent is the card label.
   */
  function chosenResumeLabel() {
    const sels = [
      '.jobs-document-upload-redesign-card__file-name',
      '.jobs-document-upload__title-container h3',
      '[class*="document-upload"] [class*="file-name"]',
      'input[type=radio]:checked + label',
      '[aria-checked="true"] [class*="file"]',
    ];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        const v = U.clean(el && (el.innerText || el.textContent));
        if (v && v.length < 120 && (C.RESUME_FILE_RE.test(v) || C.RESUME_HINT_RE.test(v))) return v;
      } catch (_) {}
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Job-page memory
  //
  // The apply form is frequently a different page (or an iframe) from the job
  // description, and it carries far less metadata. Whenever we see a real job
  // posting we hand it to the worker, which merges it into whatever the apply
  // page eventually captures for the same tab.
  // ---------------------------------------------------------------------------
  const reportSeen = debounce(() => {
    try {
      if (window.top !== window) return;
      const hasJd = P.extractJsonLd(document).length > 0;
      const looksJob = hasJd || (onAtsHost && /\/(jobs?|careers?|opening|posting|vacanc)/i.test(location.pathname));
      if (!looksJob) return;
      const meta = P.extractPageMeta(document, location.href, A.run(document, location.href));
      if (!meta.company && !meta.position) return;
      send('SEEN_JOB', { record: P.prune(meta) });
    } catch (_) {}
  }, 1200);

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension context invalidated on reload */ }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function onReady() {
    reportSeen();
    if (document.body) {
      // Some flows land straight on a confirmation page after a redirect.
      const text = (document.body.innerText || '').slice(0, 8000);
      if (onAtsHost && C.SUCCESS_PATTERNS.some((re) => re.test(text))) {
        addEvidence('successText.onload', WEIGHTS.success, 'load');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
  } else {
    onReady();
  }

  // SPA navigation: most job boards never do a full page load.
  let lastHref = location.href;
  const watchNav = () => {
    if (location.href === lastHref) return;
    const before = lastHref;
    lastHref = location.href;
    // Only a move to a genuinely different posting is a hard reset. Step
    // changes inside one apply flow must keep the evidence gathered so far.
    reset({ hard: differentPosting(before, location.href) });
    reportSeen();
  };

  /** Two URLs describe different jobs, rather than two steps of the same one. */
  function differentPosting(a, b) {
    try {
      const ua = new URL(a), ub = new URL(b);
      if (ua.origin !== ub.origin) return true;
      const idOf = (u) => (u.pathname.match(/\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}/i) || [''])[0];
      const ia = idOf(ua), ib = idOf(ub);
      if (ia && ib && ia !== ib) return true;
      return false;
    } catch { return true; }
  }
  setInterval(watchNav, 800);
  window.addEventListener('popstate', watchNav);

  // Let the popup ask this tab what job it is looking at, for manual adds.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SCRAPE_CURRENT') {
      try {
        const meta = P.extractPageMeta(document, location.href, A.run(document, location.href));
        if (state.resume) meta.resumeName = state.resume.name;
        sendResponse({ ok: true, record: P.prune(meta) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }
    return false;
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
