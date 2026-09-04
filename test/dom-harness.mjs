/**
 * Minimal DOM/extension shim so the content scripts can be executed in Node.
 *
 * Not a browser — just enough of one to load nethook -> parse -> adapters ->
 * detector in manifest order and observe what they send to the worker. The
 * detector had two separate bugs that threw at load and were swallowed, which
 * unit tests on the pure helpers could never have caught.
 */
import { pathToFileURL } from 'node:url';

class El {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.textContent = text;
    this.children = [];
    this.type = attrs.type || '';
    this.labels = [];
  }
  get innerText() {
    return [this.textContent, ...this.children.map((c) => c.innerText)].filter(Boolean).join(' ');
  }
  getAttribute(n) { return this.attrs[n] ?? null; }
  setAttribute(n, v) { this.attrs[n] = v; }
  get href() { return this.attrs.href || ''; }
  get src() { return this.attrs.src || ''; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const all = [];
    const walk = (n) => { all.push(n); n.children.forEach(walk); };
    this.children.forEach(walk);
    return all.filter((n) => matches(n, sel));
  }
  closest() { return null; }
  cloneNode() { const c = new El(this.tagName, { ...this.attrs }, this.textContent); c.children = this.children; return c; }
  remove() {}
  append(...kids) { this.children.push(...kids); return this; }
  forEach() {}
}

/** Supports the selector shapes the adapters actually use. */
function matches(node, sel) {
  sel = sel.trim();
  for (const part of sel.split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (s === node.tagName.toLowerCase()) return true;
    const attr = s.match(/^\[([\w-]+)(?:([\^*]?=)"([^"]*)")?\]$/);
    if (attr) {
      const v = node.attrs[attr[1]];
      if (v === undefined) continue;
      if (!attr[2]) return true;
      if (attr[2] === '=' && v === attr[3]) return true;
      if (attr[2] === '*=' && String(v).includes(attr[3])) return true;
      continue;
    }
    const cls = s.match(/^\.([\w-]+)$/);
    if (cls && String(node.attrs.class || '').split(/\s+/).includes(cls[1])) return true;
    const tagCls = s.match(/^(\w+)\.([\w-]+)$/);
    if (tagCls && node.tagName.toLowerCase() === tagCls[1] &&
        String(node.attrs.class || '').split(/\s+/).includes(tagCls[2])) return true;
    const typed = s.match(/^script\[type="([^"]+)"\]$/);
    if (typed && node.tagName === 'SCRIPT' && node.attrs.type === typed[1]) return true;
  }
  return false;
}

/**
 * Build a page and run the content scripts against it.
 * @returns {{messages: Array, errors: Array, fire: Function}}
 */
export async function loadPage({ url, title = '', body = [], readyState = 'complete', settle = 80 }) {
  const messages = [];
  const errors = [];
  const msgListeners = [];
  const listeners = { document: {}, window: {} };
  const store = new Map();

  const bodyEl = new El('body');
  bodyEl.children = body;

  const loc = new URL(url);
  const doc = {
    readyState,
    title,
    referrer: '',
    baseURI: url,
    body: bodyEl,
    documentElement: bodyEl,
    addEventListener: (t, fn) => { (listeners.document[t] ||= []).push(fn); },
    removeEventListener: () => {},
    querySelector: (s) => bodyEl.querySelector(s),
    querySelectorAll: (s) => bodyEl.querySelectorAll(s),
    createElement: (t) => new El(t),
  };

  const win = {
    location: loc,
    document: doc,
    addEventListener: (t, fn) => { (listeners.window[t] ||= []).push(fn); },
    removeEventListener: () => {},
    postMessage: (data) => {
      (listeners.window.message || []).forEach((fn) => {
        try { fn({ source: win, data }); } catch (e) { errors.push(e); }
      });
    },
  };
  win.top = win;
  win.self = win;

  const g = globalThis;
  const saved = {};
  // Some globals (navigator) are getter-only on the Node global object.
  const install = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(g, k);
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  };

  install('window', win);
  install('document', doc);
  install('location', loc);
  install('sessionStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
  install('MutationObserver', class { observe() {} disconnect() {} });
  install('navigator', { sendBeacon: () => true });
  install('chrome', {
    runtime: {
      id: 'testextensionidtestextensionid00',
      lastError: null,
      sendMessage: (msg, cb) => { messages.push(msg); if (cb) cb({ ok: true }); },
      onMessage: { addListener: (fn) => { msgListeners.push(fn); } },
      getManifest: () => ({ oauth2: { client_id: 'x' } }),
    },
  });
  install('XMLHttpRequest', class { open() {} send() {} addEventListener() {} });

  // The detector polls for SPA navigation. Track the handles so teardown can
  // stop them — otherwise a timer fires after the globals are gone.
  const intervals = [];
  const timeouts = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  install('setInterval', (fn, ms) => { const t = realSetInterval(fn, ms); intervals.push(t); return t; });
  // The detector arms long timers (a 15s near-miss report, a 120s observer
  // teardown). Left running they hold the test event loop open for minutes.
  install('setTimeout', (fn, ms) => { const t = realSetTimeout(fn, ms); timeouts.push(t); return t; });
  install('fetch', async () => ({ ok: true, status: 200 }));

  const bust = '?v=' + Math.random();
  const root = new URL('../extension/src/', import.meta.url);
  const load = async (rel) => {
    try { await import(pathToFileURL(new URL(rel, root).pathname).href + bust); }
    catch (e) { errors.push(Object.assign(e, { file: rel })); }
  };

  // manifest order
  await load('content/nethook.js');
  await load('common/constants.js');
  await load('common/util.js');
  await load('common/parse.js');
  await load('content/adapters.js');
  await load('content/detector.js');

  // Let the debounced reporters settle. reportSeen debounces at 1200ms, so
  // callers that assert on SEEN_JOB pass a longer settle.
  await new Promise((r) => realSetTimeout(r, settle));

  const restore = () => {
    intervals.forEach((t) => clearInterval(t));
    timeouts.forEach((t) => clearTimeout(t));
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  };
  return {
    messages, errors, listeners, win, doc,
    /** Deliver a runtime message the way the worker would, and return the reply. */
    send: (msg) => {
      let reply;
      msgListeners.forEach((fn) => { try { fn(msg, {}, (r) => { reply = r; }); } catch (e) { errors.push(e); } });
      return reply;
    },
    fire: (target, type, ev) => (listeners[target][type] || []).forEach((fn) => {
      try { fn(ev); } catch (e) { errors.push(e); }
    }),
    restore,
  };
}

export { El };
