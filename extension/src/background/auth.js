import '../common/constants.js';
import '../common/util.js';

const { C, U } = globalThis.JAT;

/**
 * Two OAuth paths:
 *
 *  - "chrome"  (default) chrome.identity.getAuthToken. Chrome owns refresh, so
 *              there is no refresh token to store. Requires a Chrome-App OAuth
 *              client bound to a fixed extension ID (see SETUP.md).
 *  - "webflow" launchWebAuthFlow + PKCE against a Web/Desktop OAuth client the
 *              user pastes into Options. Needed on Brave/Edge/Vivaldi and for
 *              unpacked installs where pinning the extension ID is a nuisance.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const KEY = 'auth';

async function readAuth() {
  const { [KEY]: a } = await chrome.storage.local.get(KEY);
  return a || {};
}
async function writeAuth(patch) {
  const a = await readAuth();
  const next = { ...a, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

async function mode() {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings && settings.authMode) || 'chrome';
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return b64url(bytes);
}
async function challenge(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// ---------------------------------------------------------------------------
// webflow
// ---------------------------------------------------------------------------
async function webflowInteractive() {
  const { settings } = await chrome.storage.local.get('settings');
  const clientId = settings && settings.oauthClientId;
  const clientSecret = (settings && settings.oauthClientSecret) || '';
  if (!clientId) throw new Error('No OAuth client ID configured. Open Options and paste one.');

  const verifier = randomVerifier();
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: C.SCOPES.join(' '),
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: `${AUTH_URL}?${params}`,
    interactive: true,
  });
  const code = new URL(redirect).searchParams.get('code');
  if (!code) throw new Error('Authorization was cancelled.');

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'Token exchange failed');

  await writeAuth({
    accessToken: json.access_token,
    refreshToken: json.refresh_token || (await readAuth()).refreshToken || '',
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000 - 60_000,
  });
  return json.access_token;
}

async function webflowRefresh() {
  const a = await readAuth();
  if (!a.refreshToken) return null;
  const { settings } = await chrome.storage.local.get('settings');
  const body = new URLSearchParams({
    client_id: settings.oauthClientId,
    refresh_token: a.refreshToken,
    grant_type: 'refresh_token',
  });
  if (settings.oauthClientSecret) body.set('client_secret', settings.oauthClientSecret);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) return null;
  await writeAuth({
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000 - 60_000,
  });
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Current access token, refreshing silently if possible. */
export async function getToken({ interactive = false } = {}) {
  if ((await mode()) === 'webflow') {
    const a = await readAuth();
    if (a.accessToken && a.expiresAt > Date.now()) return a.accessToken;
    const refreshed = await webflowRefresh();
    if (refreshed) return refreshed;
    if (!interactive) return null;
    return webflowInteractive();
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive, scopes: C.SCOPES }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) {
        if (!interactive) return resolve(null);
        return reject(new Error(err ? err.message : 'Sign-in was cancelled.'));
      }
      resolve(token);
    });
  });
}

async function invalidate(token) {
  if ((await mode()) === 'webflow') {
    await writeAuth({ accessToken: '', expiresAt: 0 });
    return;
  }
  if (!token) return;
  await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
}

export async function signIn() {
  const token = await getToken({ interactive: true });
  if (!token) throw new Error('Sign-in failed.');
  const profile = await api(C.USERINFO_API);
  await writeAuth({ email: profile.email, connectedAt: Date.now() });
  return profile;
}

export async function signOut() {
  const token = await getToken({ interactive: false });
  if (token) {
    await invalidate(token);
    try { await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' }); } catch (_) {}
  }
  await chrome.storage.local.remove(KEY);
}

export async function authState() {
  const a = await readAuth();
  const token = await getToken({ interactive: false });
  return { connected: !!token, email: a.email || '', connectedAt: a.connectedAt || 0 };
}

/**
 * Authenticated JSON fetch against a Google API.
 * Retries once on 401 after dropping the cached token; backs off on 429/5xx.
 */
export async function api(url, options = {}) {
  const doCall = async (retryOn401 = true) => {
    const token = await getToken({ interactive: false });
    if (!token) throw Object.assign(new Error('Not connected to Google.'), { status: 401, needsAuth: true });

    const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 && retryOn401) {
      await invalidate(token);
      return doCall(false);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && json.error && (json.error.message || json.error)) || res.statusText;
      throw Object.assign(new Error(`${res.status}: ${msg}`), { status: res.status, body: json });
    }
    return json;
  };

  return U.retry(doCall, { label: url });
}
