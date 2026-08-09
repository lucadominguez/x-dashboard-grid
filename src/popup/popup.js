/* ============================================================================
 * GridX popup logic.
 * Reads settings from chrome.storage.local, renders controls, and pushes every
 * change to the active tab's content script immediately via
 * chrome.tabs.query({active,currentWindow}) + chrome.tabs.sendMessage.
 *
 * Messaging permission note: querying the ACTIVE tab's id and sendMessage-ing
 * a content script does not require the `tabs` permission; host access for the
 * active x.com / twitter.com / localhost tab is implied by the content_scripts
 * `matches` in the manifest. Badge everything with try/catch so a non-grid tab
 * (e.g. chrome://) fails silently.
 * ========================================================================== */
(() => {
  'use strict';

  const DEFAULT_KEY = 'gridxSettings';
  const DEFAULTS = {
    columnCount: 3,
    density: 'compact',
    fontScale: 1.0,
    showMedia: false,
    showMetrics: true,
    showAvatars: true,
    hidePromoted: false,
    hideRetweets: false,
    hideVerified: false,
    filterKeywords: [],
    filterHandles: [],
    extraCss: '',
    scanMode: false,
    bleed: false,
    debug: false,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    cols: $('gx-cols'),
    colsVal: $('gx-cols-val'),
    densityBtns: document.querySelectorAll('#gx-density button'),
    toggles: document.querySelectorAll('#gx-toggles button'),
    scan: $('gx-scan'),
    pause: $('gx-pause'),
    filter: $('gx-filter'),
    filterClear: $('gx-filter-clear'),
    stats: $('gx-stats'),
    sPosts: $('s-posts'),
    sHidden: $('s-hidden'),
    sCols: $('s-cols'),
    sUp: $('s-up'),
    dot: $('gx-status-dot'),
    err: $('gx-error'),
    options: $('gx-options'),
  };

  let settings = { ...DEFAULTS };
  let runtimeState = null;

  const log = (...a) => { if (settings.debug) console.log('[gridx:popup]', ...a); };

  async function load() {
    try {
      const o = await chrome.storage.local.get(DEFAULT_KEY);
      settings = { ...DEFAULTS, ...(o[DEFAULT_KEY] || {}) };
    } catch (e) { settings = { ...DEFAULTS }; }
  }

  function persist() {
    try { chrome.storage.local.set({ [DEFAULT_KEY]: settings }); } catch (e) {}
  }

  function patch(p) {
    Object.assign(settings, p);
    persist();
    renderControls();
    pushUpdate(settings);
    refreshState();
  }

  async function activeTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    } catch (e) { return null; }
  }

  async function pushUpdate(settingsObj) {
    const tab = await activeTab();
    if (!tab || tab.id == null) return;
    try { await chrome.tabs.sendMessage(tab.id, { type: 'gridx:update', settings: settingsObj }); }
    catch (e) {
      log('no receiver on active tab (ok if not a grid page):', e.message);
      if (!/x\.com|twitter|localhost|127\.0\.0\.1/.test(tab.url || '')) {
        setErr('Open a timeline to apply.');
      } else {
        setErr('Content script not ready.'); 
      }
    }
  }

  async function refreshState() {
    const tab = await activeTab();
    if (!tab || tab.id == null) { renderStats(null); return; }
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'gridx:getState' });
      runtimeState = st || null;
      renderStats(st);
    } catch (e) { runtimeState = null; renderStats(null); }
  }

  /* ---- rendering -------------------------------------------------- */
  function renderControls() {
    els.cols.value = settings.columnCount;
    els.colsVal.textContent = settings.columnCount;
    els.densityBtns.forEach((b) => b.classList.toggle('active', b.dataset.v === settings.density));
    els.toggles.forEach((b) => {
      b.classList.toggle('active', !!settings[b.dataset.k]);
    });
    els.scan.classList.toggle('active', !!settings.scanMode);
    els.pause.classList.toggle('active', !!(runtimeState && runtimeState.paused));
    elFilterFromSettings();
    els.dot.classList.toggle('on', !!(runtimeState && runtimeState.active));
  }

  function elFilterFromSettings() {
    // Keywords are also driven by the content script's own filter bar; we just
    // mirror the stored keywords so popup stays in sync.
    if (settings.filterKeywords && settings.filterKeywords.length) {
      els.filter.value = settings.filterKeywords.join(' ');
    } else if (!els.filter.value || !settings.filterKeywords) {
      // keep only when a keyword list exists; leave user typing untouched
      if (!settings.filterKeywords) els.filter.value = '';
    }
  }

  function renderStats(st) {
    const s = st || {};
    els.sPosts.textContent = s.postsRendered ?? '–';
    els.sHidden.textContent = s.postsFiltered ?? '–';
    els.sCols.textContent = s.columnCount ?? settings.columnCount ?? '–';
    els.sUp.textContent = s.gridActiveMs != null ? fmtMs(s.gridActiveMs) : '–';
    els.dot.classList.toggle('on', !!s.active);
    els.pause.classList.toggle('active', !!s.paused);
  }

  const fmtMs = (ms) => {
    let sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
  };

  function setErr(msg) { els.err.textContent = msg || ''; }

  /* ---- wire events -------------------------------------------------- */
  function wire() {
    els.cols.addEventListener('input', () => {
      patch({ columnCount: parseInt(els.cols.value, 10) || 3 });
    });

    els.densityBtns.forEach((b) => {
      b.addEventListener('click', () => patch({ density: b.dataset.v }));
    });

    els.toggles.forEach((b) => {
      b.addEventListener('click', () => patch({ [b.dataset.k]: !settings[b.dataset.k] }));
    });

    // "Scan" and "Pause" run in the content script; we proxy through as a
    // command so the content script keeps its own scan-state machine (prev/restore).
    els.scan.addEventListener('click', async () => {
      const tab = await activeTab();
      if (tab && tab.id != null) {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'gridx:command', payload: 'toggle-scan' }); }
        catch (e) { setErr('No grid on this tab.'); }
      } else { setErr('No active tab.'); }
      // fallback: flip locally if no receiver
    });
    els.pause.addEventListener('click', async () => {
      const tab = await activeTab();
      if (tab && tab.id != null) {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'gridx:command', payload: 'toggle-pause' }); }
        catch (e) { setErr('No grid on this tab.'); }
      } else { setErr('No active tab.'); }
    });

    let pending = null;
    els.filter.addEventListener('input', () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        const terms = els.filter.value.split(/[\s,]+/).filter(Boolean);
        patch({ filterKeywords: terms });
      }, 250);
    });
    els.filterClear.addEventListener('click', () => {
      els.filter.value = '';
      patch({ filterKeywords: [] });
    });

    els.options.addEventListener('click', (e) => {
      e.preventDefault();
      try { chrome.runtime.openOptionsPage(); } catch (e2) { setErr('Options unavailable'); }
    });
  }

  async function init() {
    await load();
    registerCommandHandlers();
    renderControls();
    wire();
    refreshState();
    // Lightweight live polling so stats update while the popup is open.
    setInterval(refreshState, 1500);
  }

  function registerCommandHandlers() {
    // When the user presses scan/pause in the content script, we cannot be
    // notified directly without additional plumbing, so we poll state. Keep a
    // no-op here as a stub (popup reloads fresh each open anyway).
  }

  init();
})();