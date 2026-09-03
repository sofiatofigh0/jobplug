/** Loads the extension's globalThis-based modules, with a minimal chrome stub. */
const store = { local: {} };

globalThis.chrome = {
  runtime: { id: 'test-extension-id', lastError: null, getURL: (p) => 'chrome-extension://test/' + p },
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...store.local };
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => k in store.local).map((k) => [k, store.local[k]]));
      },
      async set(obj) { Object.assign(store.local, obj); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store.local[k]); },
    },
  },
  identity: {
    getRedirectURL: () => 'https://test.chromiumapp.org/',
    getAuthToken: (_opts, cb) => cb('fake-access-token'),
    removeCachedAuthToken: (_o, cb) => cb && cb(),
  },
  alarms: { create() {}, clear: async () => {}, onAlarm: { addListener() {} } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  notifications: { create() {} },
  tabs: { query: async () => [], create: async () => {}, sendMessage: async () => null },
  contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
};

export function resetStorage() { for (const k of Object.keys(store.local)) delete store.local[k]; }
export const rawStorage = store.local;

await import('../extension/src/common/constants.js');
await import('../extension/src/common/util.js');
await import('../extension/src/common/parse.js');

export const { C, U, P } = globalThis.JAT;
