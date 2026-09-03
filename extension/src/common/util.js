/** Small helpers shared by content scripts, popup, options and the worker. */
(function (root) {
  const U = {};

  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Fast, stable, non-cryptographic 32-bit hash rendered as base36. */
  U.hash = function (str) {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };

  /** Collapse whitespace, strip zero-width chars, trim. */
  U.clean = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/[​-‍﻿­]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  /** Lowercased, punctuation-free form used for fuzzy company comparison. */
  U.slug = function (s) {
    return U.clean(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };

  /** Strip legal suffixes and common noise from a company name. */
  const COMPANY_NOISE =
    /\b(inc|inc\.|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|s\.a|sa|ab|oy|plc|pte|pty|bv|nv|holdings|group|labs?|technologies|technology|software|solutions|systems|the)\b/gi;
  U.normCompany = function (s) {
    let out = U.clean(s).replace(/[‘’“”]/g, '');
    out = out.replace(/\s*[|·–—-]\s*(careers|jobs|hiring|job board).*$/i, '');
    out = out.replace(COMPANY_NOISE, ' ');
    return U.slug(out);
  };

  /** Normalise a job title for dedupe: drop seniority-neutral noise + req IDs. */
  U.normTitle = function (s) {
    return U.slug(
      U.clean(s)
        .replace(/\(.*?\)/g, ' ')
        .replace(/\b(req(uisition)?\s*#?\s*[\w-]+|job\s*id\s*:?\s*[\w-]+|#\s*\w{3,})\b/gi, ' ')
        .replace(/\b(remote|hybrid|onsite|on-site|full[- ]?time|part[- ]?time|contract)\b/gi, ' ')
    );
  };

  U.hostOf = function (url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  };

  /** Registrable-ish domain: last two labels, with a small public-suffix list. */
  const TWO_LABEL_TLDS = new Set([
    'co.uk','org.uk','ac.uk','gov.uk','co.jp','co.kr','com.au','net.au','org.au',
    'co.nz','co.in','co.za','com.br','com.mx','com.sg','com.hk','co.il',
  ]);
  U.rootDomain = function (hostOrUrl) {
    const host = hostOrUrl.includes('://') ? U.hostOf(hostOrUrl) : String(hostOrUrl).toLowerCase();
    const parts = host.replace(/^www\./, '').split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const last2 = parts.slice(-2).join('.');
    if (TWO_LABEL_TLDS.has(last2)) return parts.slice(-3).join('.');
    return last2;
  };

  /** ISO date (YYYY-MM-DD) in the user's local timezone. */
  U.isoDate = function (d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt)) return '';
    const off = dt.getTimezoneOffset() * 60000;
    return new Date(dt.getTime() - off).toISOString().slice(0, 10);
  };

  U.isoDateTime = function (d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt)) return '';
    const off = dt.getTimezoneOffset() * 60000;
    return new Date(dt.getTime() - off).toISOString().slice(0, 19).replace('T', ' ');
  };

  U.daysBetween = function (a, b) {
    const d1 = new Date(a), d2 = new Date(b);
    if (isNaN(d1) || isNaN(d2)) return '';
    return Math.max(0, Math.round((d2 - d1) / 86400000));
  };

  /** Serial date number Google Sheets understands (days since 1899-12-30). */
  U.sheetsSerial = function (d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt)) return null;
    const off = dt.getTimezoneOffset() * 60000;
    return (dt.getTime() - off) / 86400000 + 25569;
  };

  /** Retry with exponential backoff; retries 429/5xx and network errors. */
  U.retry = async function (fn, { tries = 4, base = 700, label = 'op' } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = err && err.status;
        const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
        if (!retryable || i === tries - 1) break;
        await U.sleep(base * Math.pow(2, i) + Math.random() * 250);
      }
    }
    throw Object.assign(lastErr || new Error(`${label} failed`), { label });
  };

  /** Column letter for a 0-based index (0 -> A, 26 -> AA). */
  U.colLetter = function (i) {
    let s = '', n = i + 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - r) / 26); }
    return s;
  };

  root.JAT = root.JAT || {};
  root.JAT.U = U;
})(typeof globalThis !== 'undefined' ? globalThis : self);
