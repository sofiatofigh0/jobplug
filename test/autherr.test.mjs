import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';

// explainAuthError reads the live manifest, so stub what it needs.
chrome.runtime.getManifest = () => ({ oauth2: { client_id: '634250697245-abc.apps.googleusercontent.com' } });
chrome.runtime.id = 'hecbdhgbageicialaihgpibpbbdbaked';

const { explainAuthError } = await import('../extension/src/background/auth.js');

test('bad client id names both causes and the current extension ID', () => {
  const r = explainAuthError(new Error("OAuth2 request failed: Service responded with error: 'bad client id: 634250697245-abc.apps.googleusercontent.com'"));
  assert.match(r.title, /rejected the OAuth client/i);
  assert.equal(r.steps.length, 3);
  assert.match(r.steps[0], /Chrome app/, 'must call out the wrong-client-type cause');
  assert.match(r.steps[1], /hecbdhgbageicialaihgpibpbbdbaked/, 'must show the live extension ID to compare against');
  assert.match(r.steps[2], /Browser redirect/, 'must offer the fast way out');
});

test('an unset placeholder is diagnosed before anything else', () => {
  chrome.runtime.getManifest = () => ({ oauth2: { client_id: 'REPLACE_WITH_YOUR_CHROME_APP_OAUTH_CLIENT_ID.apps.googleusercontent.com' } });
  const r = explainAuthError(new Error('bad client id: REPLACE_WITH_YOUR...'));
  assert.match(r.title, /No OAuth client configured/i);
  chrome.runtime.getManifest = () => ({ oauth2: { client_id: 'real-id' } });
});

test('redirect_uri_mismatch quotes the exact URI to register', () => {
  const r = explainAuthError(new Error('Authorization failed: redirect_uri_mismatch'), 'webflow');
  assert.match(r.steps[0], /chromiumapp\.org/);
});

test('a declined consent points at the test-user list', () => {
  const r = explainAuthError(new Error('The user did not approve access. access_denied'));
  assert.match(r.steps[1], /Test users/i);
  assert.equal(r.fatal, false, 'retrying is worth offering here');
});

test('an unrecognised error still surfaces its message', () => {
  const r = explainAuthError(new Error('Network unreachable'));
  assert.equal(r.title, 'Network unreachable');
  assert.deepEqual(r.steps, []);
});
