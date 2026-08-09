/* ============================================================================
 * GridX options page logic.
 * Full-page editor: every setting persisted to chrome.storage.local and pushed
 * to every open grid tab via chrome.tabs.query + sendMessage (requires only the
 * host access implied by content_scripts matches - no `tabs` permission).
 * Also manages column presets and filter presets.
 * ========================================================================== */
(() => {
  'use strict';

  const KEY = 'gridxSettings';
  const COL_PRESET_KEY = 'gridxColumnPresets';
  const FILTER_PRESET_KEY = 'gridxFilterPresets';
  const DEFAULTS = {
    columnCount: 3, density: 'compact', fontScale: 1.0,
    showMedia: false, showMetrics: true, showAvatars: true,
    hidePromoted: false, hideRetweets: false, hideVerified: false,
    filterKeywords: [], filterHandles: [], extraCss: '',
    scanMode: false, bleed: false, debug: false,
  };
  const COL_KEYS = ['columnCount', 'density', 'fontScale', 'bleed'];

  const $ = (id) => document.getElementById(id);
  const els = {
    cols: $('gx-cols'), colsVal: $('gx-cols-val'),
    densityBtns: document.querySelectorAll('#gx-density button'),
    font: $('gx-font'), fontVal: $('gx-font-val'),
    checks: ['bleed', 'showMedia', 'showMetrics', 'showAvatars', 'hidePromoted', 'hideRetweets', 'hideVerified'],
    colPresetSelect: $('gx-col-presets'), colName: $('gx-col-name'),
    colSave: $('gx-col-save'), colDel: $('gx-col-del'),
    filterPresetSelect: $('gx-filter-presets'), filterName: $('gx-filter-name'),
    filterSave: $('gx-filter-save'), filterDel: $('gx-filter-del'),
    extraCss: $('gx-extra-css'), cssApply: $('gx-css-apply'),
    reset: $('gx-reset'), status: $('gx-status'),
  };

  let settings = { ...DEFAULTS };
  let colPresets = {};
  let filterPresets = {};

  const log = (...a) => { if (settings.debug) console.log('[gridx:options]', ...a); };
  const toast = (msg) => {
    els.status.textContent = msg;
    els.status.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.status.classList.remove('show'), 1600);
  };

  async function load() {
    try {
      const o = await chrome.storage.local.get([KEY, COL_PRESET_KEY, FILTER_PRESET_KEY]);
      settings = { ...DEFAULTS, ...(o[KEY] || {}) };
      colPresets = o[COL_PRESET_KEY] || {};
      filterPresets = o[FILTER_PRESET_KEY] || {};
    } catch (e) { /* defaults */ }
  }

  function persist() {
    try {
      chrome.storage.local.set({
        [KEY]: settings, [COL_PRESET_KEY]: colPresets, [FILTER_PRESET_KEY]: filterPresets,
      });
    } catch (e) { /* noop */ }
  }

  function patch(p) {
    Object.assign(settings, p);
    persist();
    render();
    pushAll(settings);
  }

  async function pushAll(s) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
    for (const t of tabs) {
      if (!t.id || t.id === chrome.tabs.TAB_ID_NONE) continue;
      chrome.tabs.sendMessage(t.id, { type: 'gridx:update', settings: s }).catch(() => {});
    }
  }

  /* ---- render -------------------------------------------------- */
  function render() {
    els.cols.value = settings.columnCount;
    els.colsVal.textContent = settings.columnCount;
    els.font.value = settings.fontScale;
    els.fontVal.textContent = settings.fontScale.toFixed(2) + '×';
    els.densityBtns.forEach((b) => b.classList.toggle('active', b.dataset.v === settings.density));
    for (const id of els.checks) if ($(id)) $(id).checked = !!settings[id];
    els.extraCss.value = settings.extraCss || '';
    renderPresetSelects();
  }

  function renderPresetSelects() {
    els.colPresetSelect.innerHTML = '<option value="">(pick to load)</option>' +
      Object.keys(colPresets).map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    els.filterPresetSelect.innerHTML = '<option value="">(pick to load)</option>' +
      Object.keys(filterPresets).map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---- preset helpers -------------------------------------------- */
  function saveColPreset() {
    const name = (els.colName.value || '').trim();
    if (!name) { toast('enter a name'); return; }
    const p = {};
    for (const k of COL_KEYS) p[k] = settings[k];
    colPresets[name] = p;
    persist(); renderPresetSelects();
    toast('column preset "' + name + '" saved');
  }
  function loadColPreset() {
    const name = els.colPresetSelect.value;
    if (name && colPresets[name]) {
      patch(colPresets[name]);
      toast('loaded "' + name + '"');
    }
  }
  function delColPreset() {
    const name = els.colPresetSelect.value;
    if (name in colPresets) { delete colPresets[name]; persist(); renderPresetSelects(); toast('deleted'); }
  }

  function saveFilterPreset() {
    const name = (els.filterName.value || '').trim();
    if (!name) { toast('enter a name'); return; }
    filterPresets[name] = { filterKeywords: settings.filterKeywords, filterHandles: settings.filterHandles };
    persist(); renderPresetSelects();
    toast('filter preset "' + name + '" saved');
  }
  function loadFilterPreset() {
    const name = els.filterPresetSelect.value;
    if (name && filterPresets[name]) {
      patch(filterPresets[name]);
      toast('loaded "' + name + '"');
    }
  }
  function delFilterPreset() {
    const name = els.filterPresetSelect.value;
    if (name in filterPresets) { delete filterPresets[name]; persist(); renderPresetSelects(); toast('deleted'); }
  }

  /* ---- wire ------------------------------------------------------ */
  function wire() {
    els.cols.addEventListener('input', () => patch({ columnCount: parseInt(els.cols.value, 10) || 3 }));
    els.densityBtns.forEach((b) => b.addEventListener('click', () => patch({ density: b.dataset.v })));
    els.font.addEventListener('input', () => {
      const v = parseFloat(els.font.value) || 1;
      els.fontVal.textContent = v.toFixed(2) + '×';
      patch({ fontScale: v });
    });
    for (const id of els.checks) {
      $(id).addEventListener('change', () => patch({ [id]: $(id).checked }));
    }
    els.cssApply.addEventListener('click', () => { patch({ extraCss: els.extraCss.value }); toast('extra CSS applied'); });
    els.reset.addEventListener('click', () => {
      settings = { ...DEFAULTS };
      persist(); render(); pushAll(settings);
      toast('reset to defaults');
    });

    els.colSave.addEventListener('click', saveColPreset);
    els.colPresetSelect.addEventListener('change', loadColPreset);
    els.colDel.addEventListener('click', delColPreset);
    els.filterSave.addEventListener('click', saveFilterPreset);
    els.filterPresetSelect.addEventListener('change', loadFilterPreset);
    els.filterDel.addEventListener('click', delFilterPreset);
  }

  async function init() {
    await load();
    render();
    wire();
  }
  init();
})();