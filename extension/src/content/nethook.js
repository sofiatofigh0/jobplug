/**
 * MAIN-world network hook.
 *
 * Content scripts live in an isolated world and cannot see a page's own
 * fetch/XHR traffic. Almost every modern ATS submits applications from
 * JavaScript, so without this we would only ever catch old-style form posts.
 * This script wraps fetch / XMLHttpRequest / sendBeacon, and forwards a
 * summary of anything that looks like an application submit (plus any file
 * names in the request body) to the isolated world via postMessage.
 *
 * Design rules: never change observable behaviour, never throw into page code,
 * never retain request bodies.
 */
(function () {
  if (window.__jatNetHookInstalled) return;
  window.__jatNetHookInstalled = true;

  const TAG = '__JAT_NET__';
  const APPLY_HINT = /(appl(y|ication|ications)|candidate|submit|jobs?\/[^/]+\/(apply|submit)|graphql|voyager)/i;
  const FILE_RE = /\.(pdf|docx?|rtf|txt|pages|odt)$/i;
  const MAX_EVENTS = 400;
  let sent = 0;

  function post(payload) {
    if (sent++ > MAX_EVENTS) return;
    try {
      window.postMessage(Object.assign({ [TAG]: true, ts: Date.now() }, payload), '*');
    } catch (_) { /* never let instrumentation break the page */ }
  }

  function absolute(url) {
    try { return new URL(String(url), document.baseURI).href; } catch { return String(url || ''); }
  }

  /** Pull file metadata out of a request body without holding on to the bytes. */
  function describeBody(body) {
    const files = [];
    let textHint = '';
    try {
      if (body instanceof FormData) {
        for (const [field, value] of body.entries()) {
          if (value && typeof value === 'object' && typeof value.name === 'string' && 'size' in value) {
            files.push({ field: String(field), name: value.name, size: value.size, type: value.type || '' });
          } else if (typeof value === 'string' && value.length < 200 && FILE_RE.test(value)) {
            files.push({ field: String(field), name: value, size: 0, type: '' });
          }
        }
      } else if (typeof body === 'string' && body.length < 200000) {
        textHint = body.slice(0, 4000);
        const m = body.match(/"(?:file_?name|filename|resume_?name|name)"\s*:\s*"([^"]{3,120}\.(?:pdf|docx?|rtf|txt))"/i);
        if (m) files.push({ field: 'json', name: m[1], size: 0, type: '' });
      } else if (body instanceof URLSearchParams) {
        textHint = body.toString().slice(0, 4000);
      }
    } catch (_) { /* opaque body types are fine to skip */ }
    return { files, textHint };
  }

  function interesting(url, method, files) {
    if (!/^(POST|PUT|PATCH)$/i.test(method || '')) return false;
    return files.length > 0 || APPLY_HINT.test(url);
  }

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '', method = 'GET', desc = { files: [], textHint: '' };
      try {
        if (typeof input === 'string' || input instanceof URL) {
          url = absolute(input);
          method = (init && init.method) || 'GET';
        } else if (input && typeof input === 'object') {
          url = absolute(input.url || '');
          method = (init && init.method) || input.method || 'GET';
        }
        // Body inspection is the expensive part — skip it for the GETs that
        // make up almost all of a page's traffic.
        if (init && init.body && /^(POST|PUT|PATCH)$/i.test(method)) desc = describeBody(init.body);
      } catch (_) { /* fall through with what we have */ }

      const p = origFetch.apply(this, arguments);
      try {
        if (interesting(url, method, desc.files)) {
          p.then(
            (res) => post({ kind: 'net', via: 'fetch', url, method, status: res && res.status, ok: !!(res && res.ok), files: desc.files, textHint: desc.textHint }),
            () => post({ kind: 'net', via: 'fetch', url, method, status: 0, ok: false, files: desc.files, textHint: desc.textHint })
          );
        }
      } catch (_) { /* ignore */ }
      return p;
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try { this.__jat = { method: String(method || 'GET'), url: absolute(url) }; } catch (_) {}
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        const meta = this.__jat;
        if (meta && /^(POST|PUT|PATCH)$/i.test(meta.method)) {
          const desc = describeBody(body);
          if (interesting(meta.url, meta.method, desc.files)) {
            this.addEventListener('loadend', function () {
              post({
                kind: 'net', via: 'xhr', url: meta.url, method: meta.method,
                status: this.status, ok: this.status >= 200 && this.status < 300,
                files: desc.files, textHint: desc.textHint,
              });
            });
          }
        }
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  // --- sendBeacon ----------------------------------------------------------
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      const result = origBeacon(url, data);
      try {
        const abs = absolute(url);
        const desc = describeBody(data);
        if (interesting(abs, 'POST', desc.files)) {
          post({ kind: 'net', via: 'beacon', url: abs, method: 'POST', status: result ? 200 : 0, ok: !!result, files: desc.files, textHint: desc.textHint });
        }
      } catch (_) {}
      return result;
    };
  }

  // --- file pickers --------------------------------------------------------
  // Catch the resume the moment it is chosen, even if the page uploads it in a
  // way we cannot see (e.g. straight to S3 with a signed URL).
  document.addEventListener(
    'change',
    function (e) {
      try {
        const el = e.target;
        if (!el || el.tagName !== 'INPUT' || el.type !== 'file' || !el.files || !el.files.length) return;
        const files = Array.from(el.files).map((f) => ({
          field: el.name || el.id || '',
          name: f.name, size: f.size, type: f.type || '',
          label: fieldLabel(el),
        }));
        post({ kind: 'file', url: location.href, files });
      } catch (_) {}
    },
    true
  );

  function fieldLabel(el) {
    try {
      const bits = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('data-testid')];
      if (el.labels && el.labels.length) bits.push(el.labels[0].innerText);
      const wrap = el.closest('label, .field, [class*="upload"], [class*="attach"]');
      if (wrap) bits.push((wrap.innerText || '').slice(0, 120));
      return bits.filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch { return ''; }
  }
})();
