/* JobPlug popup. Reads state from the service worker and renders three tabs. */
(function () {
  const { C, U } = globalThis.JAT;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let state = null;

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('No response from background'));
        if (!res.ok) return reject(Object.assign(new Error(res.error), { needsAuth: res.needsAuth }));
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
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Compact currency: $185K, $1.2M, $4.5B. */
  function money(n) {
    if (n == null || n === '' || !isFinite(n)) return '';
    const v = Number(n);
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + v;
  }

  function relDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return U.isoDate(d);
  }

  const STATUS_TONE = {
    [C.STATUS.OFFER]: 'good',
    [C.STATUS.INTERVIEW]: 'info',
    [C.STATUS.ONSITE]: 'info',
    [C.STATUS.SCREEN]: 'info',
    [C.STATUS.ASSESSMENT]: 'serious',
    [C.STATUS.ACKNOWLEDGED]: 'warning',
    [C.STATUS.REJECTED]: 'critical',
    [C.STATUS.GHOSTED]: '',
    [C.STATUS.APPLIED]: '',
    [C.STATUS.WITHDRAWN]: '',
  };
  // Status colour never carries meaning alone — every pill is labelled, and the
  // ones that matter most also carry a glyph.
  const STATUS_ICON = {
    [C.STATUS.OFFER]: '★',
    [C.STATUS.REJECTED]: '✕',
    [C.STATUS.INTERVIEW]: '●',
    [C.STATUS.SCREEN]: '●',
    [C.STATUS.ONSITE]: '●',
  };

  function statusPill(status) {
    const tone = STATUS_TONE[status] || '';
    const icon = STATUS_ICON[status] ? `<span aria-hidden="true">${STATUS_ICON[status]}</span>` : '';
    return `<span class="pill ${tone}">${icon}${esc(status)}</span>`;
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------
  function bars(rows, { max = 6, valueOf, labelOf, captionOf }) {
    const list = rows.filter((r) => r.applied > 0).slice(0, max);
    if (!list.length) return '<div class="empty">Not enough data yet.</div>';
    const peak = Math.max(...list.map(valueOf), 1);
    return `<div class="bars">${list.map((r) => {
      const v = valueOf(r);
      const w = Math.max(2, Math.round((v / peak) * 100));
      return `<div class="bar-row">
        <span class="name" title="${esc(labelOf(r))}">${esc(labelOf(r))}</span>
        <span class="num">${esc(captionOf(r))}</span>
        <span class="track"><span class="fill" style="width:${w}%"></span></span>
      </div>`;
    }).join('')}</div>`;
  }

  function renderOverview() {
    const s = state.stats;
    const body = $('#overview-body');

    if (!s.total) {
      body.innerHTML = `<div class="empty">
        No applications tracked yet.<br><br>
        Apply to a job in this browser and JobPlug will log it automatically —
        or use the <b>Add</b> tab to enter one by hand.
      </div>`;
      return;
    }

    const interviewCaption = (r) =>
      `${r.interviews}/${r.applied} · ${r.interviewRate}%`;

    body.innerHTML = `
      <div class="hero">
        <div class="label">Applications submitted</div>
        <div class="value">${s.total}</div>
        <div class="sub">${s.awaiting} still waiting on a reply${s.ghosted ? ` · ${s.ghosted} gone quiet` : ''}</div>
      </div>

      <div class="kpis">
        <div class="tile">
          <div class="label">Heard back</div>
          <div class="value">${s.responded}</div>
          <div class="delta">${s.responseRate}% of applications</div>
        </div>
        <div class="tile">
          <div class="label">Interview invites</div>
          <div class="value">${s.interviews}</div>
          <div class="delta">${s.interviewRate}% of applications</div>
        </div>
        <div class="tile">
          <div class="label">Offers</div>
          <div class="value">${s.offers}</div>
          <div class="delta">${s.offerRate}% of applications</div>
        </div>
      </div>

      <div class="kpis">
        <div class="tile">
          <div class="label">Median reply time</div>
          <div class="value">${s.medianDaysToResponse == null ? '—' : s.medianDaysToResponse + 'd'}</div>
          <div class="delta">from applying</div>
        </div>
        <div class="tile">
          <div class="label">Median to invite</div>
          <div class="value">${s.medianDaysToInterview == null ? '—' : s.medianDaysToInterview + 'd'}</div>
          <div class="delta">from applying</div>
        </div>
        <div class="tile">
          <div class="label">Median comp</div>
          <div class="value">${s.medianCompMidpoint == null ? '—' : money(s.medianCompMidpoint)}</div>
          <div class="delta">${s.compCoverage}% list pay</div>
        </div>
      </div>

      <h2 class="section">Interview rate by resume <span class="hint">— which version lands</span></h2>
      ${bars(s.byResume, { valueOf: (r) => r.interviewRate, labelOf: (r) => r.key, captionOf: interviewCaption })}

      <h2 class="section">By work mode</h2>
      ${bars(s.byWorkMode, { valueOf: (r) => r.applied, labelOf: (r) => r.key, captionOf: (r) => `${r.applied} applied · ${r.interviewRate}% invited` })}

      <h2 class="section">By company stage</h2>
      ${bars(s.byStage, { valueOf: (r) => r.applied, labelOf: (r) => r.key, captionOf: (r) => `${r.applied} applied · ${r.interviewRate}% invited` })}

      <h2 class="section">By board</h2>
      ${bars(s.byBoard, { valueOf: (r) => r.applied, labelOf: (r) => r.key, captionOf: (r) => `${r.applied} applied · ${r.interviewRate}% invited` })}

      <h2 class="section">Applications per week</h2>
      ${bars(s.byWeek, { max: 8, valueOf: (r) => r.applied, labelOf: (r) => 'Week of ' + r.key, captionOf: (r) => `${r.applied} applied · ${r.interviews} invites` })}
    `;
  }

  function renderAlerts() {
    const box = $('#alerts');
    const chunks = [];

    if (!state.auth.connected) {
      chunks.push(`<div class="banner warn">
        <div class="grow"><strong>Not connected to Google</strong>
        Applications are being saved locally, but nothing reaches your spreadsheet and Gmail is not being watched.</div>
        <button class="primary" id="btn-connect">Connect</button>
      </div>`);
    }

    for (const p of state.pending) {
      chunks.push(`<div class="banner" data-pending="${esc(p.pendingId)}">
        <div class="grow">
          <strong>Did you just apply?</strong>
          ${esc(p.position || 'Role')} @ ${esc(p.company || 'unknown company')}
          ${p.resumeName ? ` · ${esc(p.resumeName)}` : ''}
        </div>
        <button class="primary" data-confirm="${esc(p.pendingId)}">Log it</button>
        <button class="ghost" data-discard="${esc(p.pendingId)}">No</button>
      </div>`);
    }

    box.innerHTML = chunks.join('');

    const connect = $('#btn-connect');
    if (connect) connect.addEventListener('click', async () => {
      connect.disabled = true; connect.textContent = 'Connecting…';
      try { await send('SIGN_IN'); toast('Connected — spreadsheet ready.'); await load(); }
      catch (err) { toast(err.message); connect.disabled = false; connect.textContent = 'Connect'; }
    });

    $$('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await send('CONFIRM_PENDING', { pendingId: b.dataset.confirm }); toast('Logged.'); await load(); }
      catch (err) { toast(err.message); }
    }));
    $$('[data-discard]').forEach((b) => b.addEventListener('click', async () => {
      await send('DISCARD_PENDING', { pendingId: b.dataset.discard });
      await load();
    }));
  }

  // -------------------------------------------------------------------------
  // Applications list
  // -------------------------------------------------------------------------
  function renderList() {
    const q = U.slug($('#search').value || '');
    const list = state.apps.filter((a) => {
      if (!q) return true;
      return U.slug([a.company, a.position, a.resumeLabel, a.resumeName, a.status, a.location, a.board].join(' ')).includes(q);
    });

    const box = $('#app-list');
    if (!list.length) {
      box.innerHTML = `<div class="empty">${state.apps.length ? 'Nothing matches that filter.' : 'No applications yet.'}</div>`;
      return;
    }

    box.innerHTML = list.slice(0, 120).map((a) => {
      const facts = [
        a.workMode,
        a.location,
        (a.salaryMin || a.salaryMax) ? `${money(a.salaryMin)}${a.salaryMax && a.salaryMax !== a.salaryMin ? '–' + money(a.salaryMax) : ''}` : '',
        a.companyStage,
        a.totalRaised ? `${money(a.totalRaised)} raised` : '',
        a.valuation ? `${money(a.valuation)} valuation` : '',
        a.headcount ? `${a.headcount} people` : '',
        a.board,
      ].filter(Boolean);

      return `<div class="card" data-id="${esc(a.id)}">
        <div class="top">
          <div class="title">
            ${a.jdUrl ? `<a href="${esc(a.jdUrl)}" target="_blank" rel="noreferrer">${esc(a.position || 'Untitled role')}</a>` : esc(a.position || 'Untitled role')}
            <div class="meta"><b>${esc(a.company || '—')}</b> · applied ${esc(relDate(a.appliedAt))}${a.resumeLabel ? ` · ${esc(a.resumeLabel)}` : ''}</div>
          </div>
          ${statusPill(a.status)}
        </div>
        ${facts.length ? `<div class="meta">${facts.map((f) => esc(f)).join(' · ')}</div>` : ''}
        ${a.lastEmailSubject ? `<div class="meta muted">Last email: ${esc(a.lastEmailSubject.slice(0, 70))}${a.threadId ? ` · <a href="https://mail.google.com/mail/u/0/#all/${esc(a.threadId)}" target="_blank" rel="noreferrer">open</a>` : ''}</div>` : ''}
        <div class="row-actions">
          <select data-status="${esc(a.id)}" title="Change status">
            ${Object.values(C.STATUS).map((s) => `<option${s === a.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <button class="ghost" data-note="${esc(a.id)}">${a.notes ? 'Edit note' : 'Note'}</button>
          <button class="danger right" data-del="${esc(a.id)}">Delete</button>
        </div>
        <div class="note-editor" data-editor="${esc(a.id)}" hidden>
          <textarea data-note-input="${esc(a.id)}" placeholder="Recruiter name, referral, follow-up date…">${esc(a.notes || '')}</textarea>
          <div class="row-actions">
            <button class="primary" data-note-save="${esc(a.id)}">Save note</button>
            <button class="ghost" data-note-cancel="${esc(a.id)}">Cancel</button>
          </div>
        </div>
      </div>`;
    }).join('');

    $$('[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
      try {
        await send('UPDATE_APP', { id: sel.dataset.status, patch: { status: sel.value } });
        toast('Status updated.');
        await load();
      } catch (err) { toast(err.message); }
    }));

    // Notes edit inline. Native prompt()/confirm() are avoided throughout the
    // popup: the popup window closes as soon as it loses focus, which cancels
    // the dialog and loses whatever was typed.
    $$('[data-note]').forEach((b) => b.addEventListener('click', () => {
      const editor = document.querySelector(`[data-editor="${CSS.escape(b.dataset.note)}"]`);
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.querySelector('textarea').focus();
    }));

    $$('[data-note-cancel]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.noteCancel;
      const editor = document.querySelector(`[data-editor="${CSS.escape(id)}"]`);
      const app = state.apps.find((a) => a.id === id);
      editor.querySelector('textarea').value = app.notes || '';
      editor.hidden = true;
    }));

    $$('[data-note-save]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.noteSave;
      const notes = document.querySelector(`[data-note-input="${CSS.escape(id)}"]`).value.trim();
      b.disabled = true;
      try { await send('UPDATE_APP', { id, patch: { notes } }); toast('Note saved.'); await load(); }
      catch (err) { toast(err.message); b.disabled = false; }
    }));

    // Delete arms on the first click and fires on the second.
    const armed = new Map();
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.del;
      if (!armed.get(id)) {
        armed.set(id, setTimeout(() => { armed.delete(id); b.textContent = 'Delete'; b.classList.remove('armed'); }, 4000));
        b.textContent = 'Really delete?';
        b.classList.add('armed');
        return;
      }
      clearTimeout(armed.get(id));
      armed.delete(id);
      b.disabled = true;
      try { await send('DELETE_APP', { id }); toast('Deleted from the sheet too.'); await load(); }
      catch (err) { toast(err.message); b.disabled = false; }
    }));
  }

  // -------------------------------------------------------------------------
  // Add form
  // -------------------------------------------------------------------------
  const FORM_FIELDS = ['company', 'position', 'jdUrl', 'appliedAt', 'resumeName', 'workMode',
    'location', 'salaryMin', 'salaryMax', 'companyStage', 'companyDomain', 'totalRaised', 'valuation', 'notes'];

  async function fillFromTab() {
    try {
      const { record } = await send('SCRAPE_ACTIVE_TAB');
      for (const k of FORM_FIELDS) {
        const el = $('#f-' + k);
        if (!el) continue;
        if (k === 'appliedAt') { el.value = U.isoDate(new Date()); continue; }
        if (record[k] != null && record[k] !== '') el.value = record[k];
      }
      toast('Filled from the current tab.');
    } catch (err) {
      $('#f-appliedAt').value = U.isoDate(new Date());
      toast('Could not read that tab — fill it in by hand.');
    }
  }

  async function submitAdd(e) {
    e.preventDefault();
    const record = {};
    for (const k of FORM_FIELDS) {
      const el = $('#f-' + k);
      if (!el) continue;
      const v = el.value.trim();
      if (!v) continue;
      record[k] = ['salaryMin', 'salaryMax', 'totalRaised', 'valuation'].includes(k) ? Number(v) : v;
    }
    if (record.appliedAt) record.appliedAt = new Date(record.appliedAt + 'T12:00:00').toISOString();
    try {
      const { created } = await send('ADD_MANUAL', { record });
      toast(created ? 'Application added.' : 'Existing application updated.');
      $('#add-form').reset();
      await load();
      selectTab('apps');
    } catch (err) { toast(err.message); }
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------
  function selectTab(name) {
    $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.panel === name)));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    if (name === 'add' && !$('#f-appliedAt').value) fillFromTab();
  }

  async function load() {
    state = await send('GET_STATE');
    $('#conn-dot').classList.toggle('on', state.auth.connected);
    $('#conn-dot').title = state.auth.connected ? `Connected as ${state.auth.email}` : 'Not connected to Google';
    renderAlerts();
    renderOverview();
    renderList();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.panel)));
    $('#search').addEventListener('input', () => renderList());
    $('#add-form').addEventListener('submit', submitAdd);
    $('#btn-refill').addEventListener('click', fillFromTab);
    $('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

    $('#btn-sheet').addEventListener('click', async () => {
      try { await send('OPEN_SHEET'); } catch (err) { toast(err.message); }
    });

    $('#btn-sync').addEventListener('click', async () => {
      const btn = $('#btn-sync');
      btn.disabled = true; btn.textContent = 'Syncing…';
      try {
        const gmail = await send('GMAIL_SYNC').catch(() => ({}));
        const res = await send('SYNC_NOW');
        if (!res.ok) throw new Error(res.error || 'Sync failed');
        toast(`Synced ${res.pushed} row${res.pushed === 1 ? '' : 's'}${gmail.invites ? ` · ${gmail.invites} new invite${gmail.invites === 1 ? '' : 's'}` : ''}.`);
        await load();
      } catch (err) {
        toast(err.needsAuth ? 'Reconnect Google in Settings.' : err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Sync';
      }
    });

    try { await load(); }
    catch (err) { $('#overview-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  });
})();
