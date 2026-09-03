/* JobPlug settings page. */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let settings = null;

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('No response from the background service.'));
        if (!res.ok) return reject(Object.assign(new Error(res.error), { needsAuth: res.needsAuth, explain: res.explain }));
        resolve(res.data);
      });
    });
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Chrome's OAuth errors are unactionable on their own; auth.js attaches a fix. */
  function showAuthError(err) {
    const box = $('#conn-error');
    const ex = err && err.explain;
    if (!ex) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `<strong>${esc(ex.title)}</strong>` +
      (ex.steps.length ? `<ul>${ex.steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function renderIdentity() {
    const d = await send('DIAGNOSTICS');
    $('#ext-id-live').textContent = d.extensionId;
    $('#redirect-uri-live').textContent = d.redirectUri;
    const placeholder = /REPLACE_WITH/i.test(d.manifestClientId);
    $('#manifest-client').textContent = placeholder
      ? 'not set (placeholder)'
      : (d.manifestClientId || 'not set');
    $('#id-stability').textContent = d.hasPinnedKey
      ? 'This ID is pinned by a key in manifest.json, so it stays the same wherever the folder lives.'
      : 'This ID is derived from the folder path — it changes if you move the extension folder, which breaks the OAuth client. Run npm run pin-id (or the openssl recipe in SETUP.md) to fix it permanently.';
    return d;
  }

  // -------------------------------------------------------------------------
  // Resume alias editor
  // -------------------------------------------------------------------------
  function renderAliases(list) {
    const box = $('#aliases');
    const rows = (list && list.length ? list : [{ match: '', label: '' }]);
    box.innerHTML = rows.map((a, i) => `
      <div class="alias-row" data-i="${i}">
        <input type="text" class="alias-match" placeholder="filename contains… e.g. backend_v3" value="${esc(a.match)}">
        <input type="text" class="alias-label" placeholder="show as… e.g. Backend v3" value="${esc(a.label)}">
        <button class="danger" data-remove="${i}" title="Remove">✕</button>
      </div>`).join('');
    $$('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      const current = collectAliases();
      current.splice(Number(b.dataset.remove), 1);
      renderAliases(current);
    }));
  }

  function collectAliases() {
    return $$('.alias-row').map((row) => ({
      match: row.querySelector('.alias-match').value.trim(),
      label: row.querySelector('.alias-label').value.trim(),
    })).filter((a) => a.match && a.label);
  }

  // -------------------------------------------------------------------------
  // Load / save
  // -------------------------------------------------------------------------
  const CHECKS = ['autoCapture', 'confirmBeforeLogging', 'notifications', 'gmailEnabled', 'enrichEnabled'];
  const NUMS = ['gmailPollMinutes', 'gmailLookbackDays', 'ghostAfterDays'];
  const TEXTS = ['oauthClientId', 'oauthClientSecret', 'spreadsheetId', 'enrichEndpoint', 'enrichApiKey'];

  async function load() {
    const state = await send('GET_STATE');
    settings = state.settings;
    await renderIdentity().catch(() => {});

    CHECKS.forEach((k) => { $('#' + k).checked = !!settings[k]; });
    NUMS.forEach((k) => { $('#' + k).value = settings[k]; });
    TEXTS.forEach((k) => { $('#' + k).value = settings[k] || ''; });
    $('#authMode').value = settings.authMode || 'chrome';
    $('#excludeHosts').value = (settings.excludeHosts || []).join('\n');
    renderAliases(settings.resumeAliases);
    toggleWebflow();

    const box = $('#conn-status');
    if (state.auth.connected) {
      box.className = 'status ok';
      box.innerHTML = `Connected as <b>${esc(state.auth.email || 'your Google account')}</b>. ` +
        `${state.stats.total} application${state.stats.total === 1 ? '' : 's'} tracked.` +
        (settings.lastGmailSync ? ` Gmail last checked ${new Date(settings.lastGmailSync).toLocaleString()}.` : '');
    } else {
      box.className = 'status warn';
      box.textContent = 'Not connected. Applications are still captured locally, but nothing is written to Sheets and Gmail is not watched.';
    }
  }

  function toggleWebflow() {
    $('#webflow-fields').classList.toggle('hidden', $('#authMode').value !== 'webflow');
  }

  async function save() {
    const patch = {};
    CHECKS.forEach((k) => { patch[k] = $('#' + k).checked; });
    NUMS.forEach((k) => { const v = Number($('#' + k).value); if (isFinite(v) && v > 0) patch[k] = v; });
    TEXTS.forEach((k) => { patch[k] = $('#' + k).value.trim(); });
    patch.authMode = $('#authMode').value;
    patch.excludeHosts = $('#excludeHosts').value.split('\n').map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    patch.resumeAliases = collectAliases();

    await send('SET_SETTINGS', { patch });
    settings = { ...settings, ...patch };
    $('#save-note').textContent = 'Saved ' + new Date().toLocaleTimeString();
    toast('Settings saved.');
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    const legacyId = $('#ext-id');
    if (legacyId) legacyId.textContent = chrome.runtime.id;
    const legacyUri = $('#redirect-uri');
    if (legacyUri) legacyUri.textContent = chrome.identity.getRedirectURL();

    if (new URLSearchParams(location.search).get('welcome')) {
      $('#setup-card').classList.remove('hidden');
    }

    $('#authMode').addEventListener('change', toggleWebflow);

    $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const text = $('#' + b.dataset.copy).textContent;
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
      catch { b.textContent = 'Select it'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1800);
    }));
    $('#btn-add-alias').addEventListener('click', () => renderAliases([...collectAliases(), { match: '', label: '' }]));
    $('#btn-save').addEventListener('click', () => save().catch((e) => toast(e.message)));

    $('#btn-connect').addEventListener('click', async () => {
      const btn = $('#btn-connect');
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        await save();
        const res = await send('SIGN_IN');
        $('#conn-error').classList.add('hidden');
        toast('Connected. Spreadsheet ready.');
        if (res.spreadsheetUrl) window.open(res.spreadsheetUrl, '_blank');
        await load();
      } catch (err) {
        toast(err.message);
        showAuthError(err);
      } finally {
        btn.disabled = false; btn.textContent = 'Connect Google';
      }
    });

    $('#btn-disconnect').addEventListener('click', async () => {
      if (!confirm('Disconnect Google? Your spreadsheet stays exactly as it is.')) return;
      try { await send('SIGN_OUT'); toast('Disconnected.'); await load(); }
      catch (err) { toast(err.message); }
    });

    $('#btn-test-gmail').addEventListener('click', async () => {
      try {
        const r = await send('CHECK_GMAIL_ACCESS');
        toast(`Gmail reachable — ${r.email}, ${Number(r.messagesTotal || 0).toLocaleString()} messages.`);
      } catch (err) { toast('Gmail check failed: ' + err.message); }
    });

    $('#btn-open-sheet').addEventListener('click', async () => {
      try { await save(); await send('OPEN_SHEET'); } catch (err) { toast(err.message); }
    });

    $('#btn-sync').addEventListener('click', async () => {
      const btn = $('#btn-sync');
      btn.disabled = true; btn.textContent = 'Syncing…';
      try {
        await save();
        const res = await send('SYNC_NOW');
        toast(res.ok ? `Synced ${res.pushed} row${res.pushed === 1 ? '' : 's'}.` : res.error);
        await load();
      } catch (err) { toast(err.message); }
      finally { btn.disabled = false; btn.textContent = 'Force full re-sync'; }
    });

    $('#btn-gmail-now').addEventListener('click', async () => {
      const btn = $('#btn-gmail-now');
      btn.disabled = true; btn.textContent = 'Scanning…';
      try {
        await save();
        const res = await send('GMAIL_SYNC');
        toast(res.ok
          ? `Checked ${res.considered} application${res.considered === 1 ? '' : 's'} · ${res.updates} updated · ${res.invites || 0} interview invite${res.invites === 1 ? '' : 's'}.`
          : (res.error || 'Gmail scan failed.'));
        await load();
      } catch (err) { toast(err.message); }
      finally { btn.disabled = false; btn.textContent = 'Scan Gmail now'; }
    });

    $('#btn-export').addEventListener('click', async () => {
      try {
        const { csv, filename } = await send('EXPORT_CSV');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) { toast(err.message); }
    });

    $('#btn-clear').addEventListener('click', async () => {
      if (!confirm('Delete all locally stored applications?\n\nYour Google Sheet is untouched — a later sync will not restore them, so export first if you want a copy.')) return;
      await chrome.storage.local.remove(['apps', 'pending']);
      toast('Local application data cleared.');
      await load();
    });

    try { await load(); } catch (err) { toast(err.message); }
  });
})();
