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
    scanMode: false, bleed: false, debug: false, trackReading: true,
  };
  const ACTIVITY_KEY = 'gridxActivity';
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
    track: $('gx-trackReading'),
    readEmpty: $('gx-read-empty'), readBody: $('gx-read-body'),
    readTotals: $('gx-read-totals'), readAuthors: $('gx-read-authors'),
    readWords: $('gx-read-words'), readPosts: $('gx-read-posts'),
    readRefresh: $('gx-read-refresh'), readExport: $('gx-read-export'),
    readClear: $('gx-read-clear'),
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
    for (const id of els.checks) {
      const box = $('gx-' + id);
      if (box) box.checked = !!settings[id];
    }
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
    // The checkbox ids carry the gx- prefix, the setting keys do not. Looking
    // one up by the bare key returned null, and the throw took out every
    // listener wired AFTER this line: Apply, Reset, both preset pickers, and
    // anything added later. The whole lower half of the page did nothing.
    for (const id of els.checks) {
      const box = $('gx-' + id);
      if (!box) continue;
      box.addEventListener('change', () => patch({ [id]: box.checked }));
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

    els.track.addEventListener('change', () => {
      patch({ trackReading: els.track.checked });
      toast(els.track.checked ? 'reading log on' : 'reading log off');
    });
    els.readRefresh.addEventListener('click', async () => {
      await flushOpenTabs();
      await renderReading();
      toast('reading log refreshed');
    });
    els.readExport.addEventListener('click', exportReading);
    els.readClear.addEventListener('click', clearReading);
  }


  /* ==========================================================================
   * Reading log.
   *
   * The content script records raw attention per post; the reading of it
   * happens here, so nothing is aggregated on the hot path of a scroll.
   * ========================================================================== */
  const STOP = new Set(('the a an and or but if then than that this these those to of in on at by for with from as is are was were be been being it its it\'s i you he she they we me my your our their them us do does did not no yes so just like about into over under out up down new get got can will would should could have has had who what when where why how there here all any some more most other new via rt http https www com t co amp' + '').split(' '));

  const hhmm = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  };

  function bar(value, max) {
    const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return '<span class="fill" style="width:' + pct + '%"></span>';
  }

  function rows(table, list, render) {
    table.innerHTML = list.length
      ? list.map(render).join('')
      : '<tr><td class="snip">nothing yet</td></tr>';
  }

  // Attention, not volume: a post that was on screen for a moment is not a
  // post that was read, and an account you open is worth more than one you
  // merely scroll past. Reading time on the post's own page counts double,
  // because opening a post is a deliberate act and scrolling is not.
  function score(rec) {
    return rec.dwellMs + rec.readMs * 2 + rec.opens * 4000 +
      Object.keys(rec.acts || {}).length * 6000;
  }

  async function renderReading() {
    let data = {};
    try {
      const store = await chrome.storage.local.get(ACTIVITY_KEY);
      data = (store[ACTIVITY_KEY] || {}).posts || {};
    } catch (e) { data = {}; }

    const all = Object.keys(data).map((id) => ({ id, ...data[id] }));
    const withTime = all.filter((r) => r.dwellMs > 0 || r.opens > 0 || r.readMs > 0);
    els.readEmpty.hidden = all.length > 0;
    els.readBody.hidden = all.length === 0;
    if (!all.length) return;

    const totalDwell = all.reduce((n, r) => n + r.dwellMs, 0);
    const totalRead = all.reduce((n, r) => n + r.readMs, 0);
    const opens = all.reduce((n, r) => n + r.opens, 0);
    const acts = all.reduce((n, r) => n + Object.values(r.acts || {}).reduce((x, y) => x + y, 0), 0);
    const withMedia = all.filter((r) => r.m);
    const noMedia = all.filter((r) => !r.m);
    const avg = (list) => (list.length ? list.reduce((n, r) => n + r.dwellMs, 0) / list.length : 0);

    els.readTotals.innerHTML = [
      ['posts seen', all.length],
      ['time reading', hhmm(totalDwell + totalRead)],
      ['posts opened', opens],
      ['open rate', all.length ? (opens / all.length * 100).toFixed(1) + '%' : '0%'],
      ['acted on', acts],
      ['picture / text', hhmm(avg(withMedia)) + ' · ' + hhmm(avg(noMedia))],
    ].map(([label, v]) =>
      '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>').join('');

    // --- accounts
    const byAuthor = new Map();
    for (const r of all) {
      if (!r.a) continue;
      const cur = byAuthor.get(r.a) || { a: r.a, seen: 0, opens: 0, ms: 0 };
      cur.seen++; cur.opens += r.opens; cur.ms += r.dwellMs + r.readMs;
      byAuthor.set(r.a, cur);
    }
    const authors = [...byAuthor.values()].sort((x, y) => y.ms - x.ms).slice(0, 12);
    const topA = authors.length ? authors[0].ms : 0;
    rows(els.readAuthors, authors, (a) =>
      '<tr><td>@' + esc(a.a) + '</td>' +
      '<td class="bar">' + bar(a.ms, topA) + '</td>' +
      '<td class="num">' + hhmm(a.ms) + '</td>' +
      '<td class="num">' + a.opens + '/' + a.seen + '</td></tr>');

    // --- subjects
    // A word that turns up in a quarter of everything you see is the feed's
    // vocabulary, not your taste, so it is dropped however much time sits
    // against it. Otherwise "just", "people" and "AI" win every time.
    const docFreq = new Map();
    for (const r of all) {
      const seen = new Set();
      for (const w of String(r.x || '').toLowerCase().split(/[^a-z0-9@#']+/)) {
        if (w.length < 4 || seen.has(w)) continue;
        seen.add(w);
        docFreq.set(w, (docFreq.get(w) || 0) + 1);
      }
    }
    const tooCommon = (w) => (docFreq.get(w) || 0) > Math.max(3, all.length * 0.25);

    const byWord = new Map();
    for (const r of withTime) {
      const weight = score(r);
      const seen = new Set();
      for (const raw of String(r.x || '').toLowerCase().split(/[^a-z0-9@#']+/)) {
        const w = raw.replace(/^'+|'+$/g, '');
        if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
        if (tooCommon(w)) continue;
        seen.add(w);
        byWord.set(w, (byWord.get(w) || 0) + weight);
      }
    }
    const words = [...byWord.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15);
    const topW = words.length ? words[0][1] : 0;
    rows(els.readWords, words, ([w, v]) =>
      '<tr><td>' + esc(w) + '</td>' +
      '<td class="bar">' + bar(v, topW) + '</td>' +
      '<td class="num">' + hhmm(v) + '</td></tr>');

    // --- the posts themselves
    const posts = withTime.sort((x, y) => score(y) - score(x)).slice(0, 12);
    rows(els.readPosts, posts, (r) =>
      '<tr><td class="snip">' + (r.a ? '<b>@' + esc(r.a) + '</b> ' : '') +
      esc(String(r.x || '').slice(0, 90)) + '</td>' +
      '<td class="num">' + hhmm(r.dwellMs + r.readMs) + '</td>' +
      '<td class="num">' + (r.opens ? 'opened' : '') + '</td></tr>');
  }

  async function exportReading() {
    let data = {};
    try {
      const store = await chrome.storage.local.get(ACTIVITY_KEY);
      data = store[ACTIVITY_KEY] || {};
    } catch (e) {}
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gridx-reading-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  async function clearReading() {
    if (!window.confirm('Erase the reading log? This cannot be undone.')) return;
    try { await chrome.storage.local.remove(ACTIVITY_KEY); } catch (e) {}
    await renderReading();
    toast('reading log erased');
  }

  // Open feed tabs are still holding the last few seconds of counting. Queried
  // without a url filter, the same way pushAll does it: filtering by URL needs
  // the `tabs` permission, and a message to a tab with no GridX in it simply
  // has nobody to answer.
  async function flushOpenTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
    await Promise.all(tabs.map((t) => {
      if (!t.id || t.id === chrome.tabs.TAB_ID_NONE) return null;
      return chrome.tabs.sendMessage(t.id, { type: 'gridx:flushActivity' }).catch(() => {});
    }));
  }

  async function init() {
    await load();
    render();
    wire();
    els.track.checked = settings.trackReading !== false;
    await flushOpenTabs();
    await renderReading();
  }
  init();
})();