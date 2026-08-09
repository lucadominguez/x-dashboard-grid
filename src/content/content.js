/* ============================================================================
 * GridX content script — "CSS re-flow" architecture
 * ----------------------------------------------------------------------------
 * v0.2: pivot from "DOM hoisting" (moving <article> nodes) to re-flowing X's
 * own timeline IN PLACE via CSS. This is a direct response to two real-world
 * failures of the hoisting build on live x.com:
 *
 *   1. RATE-LIMIT/block: hoisting EMPTIES X's timeline container, so X's
 *      infinite-scroll sentinel is always "in view" and X fires page-after-page
 *      of requests with no human scroll cadence -> temporary rate limit.
 *   2. OVERLAP: re-parenting tore articles out of X's grid/flex context and we
 *      aggressively overrode their internals (`all:unset`), which X's action-row
 *      icons/avatars depend on, causing the overlap you saw.
 *
 * New model: GridX does NOT move or destroy any node. It finds the container
 * X already uses for the timeline and applies `display:grid` +
 * `grid-template-columns: repeat(N, ...)` to it. X keeps ownership of scroll,
 * pagination, virtualization, clicks and layout, so:
 *   - X's sentinel stays in a real container -> normal human-scroll pagination,
 *     no rate-limit storm.
 *   - Articles keep native internals -> no icon overlap.
 *   - Clicking a post's text opens the real status (delegated <a> user gesture).
 *
 * GridX still: never calls the X API, never reads cookies, never writes,
 * never auto-scrolls, never fetches anything X wouldn't. It only styles/classes
 * the DOM and holds settings counter. `#gridx-root` is now a NON-interactive
 * overlay (pointer-events:none) carrying the filter bar / keymap / status /
 * fatal chrome; the real grid lives on X's own `.gx-stream` container.
 *
 * Debug logs are behind settings.debug, prefixed [gridx].
 * ========================================================================== */
(() => {
  'use strict';

  const NS = 'gridx';
  const CLASS_ACTIVE = 'gridx-active';
  const CLASS_SCAN = 'gridx-scan';
  const STORAGE_KEY = 'gridxSettings';
  const STATS_KEY = 'gridxStats';

  /* ------------------------------------------------------------------ *
   * Defaults & layered selector candidates (X churns its markup).
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    columnCount: 3,
    density: 'compact', // compact | cozy | roomy
    fontScale: 1.0,
    showMedia: false,
    showAvatars: true,
    showMetrics: true,
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

  const S = {
    primaryColumn: [
      '[data-testid="primaryColumn"]',
      'main section',
      'main[role="main"]',
    ],
    article: ['article[data-testid="tweet"]', 'article'],
    // Stream host candidate edges: containers we must NOT turn into a grid.
    notHost: [
      '[data-testid="primaryColumn"]',
      '[data-testid="sidebarColumn"]',
      '[data-testid="TopBar"]',
      '[data-testid="topBar"]',
      'header',
      'nav',
      'main',
      'body',
      'html',
    ],
    statusLink: ['a[href*="/status/"]'],
    sponsored: ['a[aria-label*="sponsored"]'],
    verified: ['[data-testid="icon-verified"]', 'svg[aria-label*="Verified"]'],
    metricButtons: ['[role="group"] [role="button"]', '[role="button"]'],
  };

  const ARTICLE = S.article.join(', ');
  const STATUS_LINK = S.statusLink.join(', ');
  const HIDE_CHROME = S.primaryColumn.join(', ');

  const SCAN_KEYS = [
    'columnCount', 'density', 'showAvatars', 'showMedia', 'showMetrics', 'fontScale',
  ];
  const SCAN_OVERRIDES = {
    columnCount: 8, density: 'compact', showAvatars: false,
    showMedia: false, showMetrics: false, fontScale: 0.9,
  };

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  let settings = { ...DEFAULTS };
  let active = false;
  let paused = false;
  let host = null;            // X's timeline container we columnize
  let savedStyles = null;     // host inline styles captured before changes
  let observer = null;
  let root = null;            // non-interactive overlay chrome
  let filterInput = null;
  let hintsEl = null;
  let statsEl = null;
  let keymapEl = null;
  let fatalEl = null;
  let cursorArticle = null;
  let prevSettings = null;
  let statTimer = null;
  let lastStatusTimer = null;

  const stats = { postsRendered: 0, postsFiltered: 0, gridActiveMs: 0, columnCount: 3 };

  const log = (...a) => { if (settings.debug) console.log('[' + NS + ']', ...a); };
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || lo)));
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || lo));
  const pick = (o, keys) => { const r = {}; for (const k of keys) r[k] = o[k]; return r; };

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */
  async function loadSettings() {
    try {
      const o = await chrome.storage.local.get(STORAGE_KEY);
      settings = { ...DEFAULTS, ...(o[STORAGE_KEY] || {}) };
    } catch (e) { settings = { ...DEFAULTS }; }
  }
  function saveSettings() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: settings }); } catch (e) {}
  }
  function persistCounters() {
    try { chrome.storage.local.set({ [STATS_KEY]: { ...stats } }); } catch (e) {}
  }
  async function loadCounters() {
    try {
      const o = await chrome.storage.local.get(STATS_KEY);
      if (o[STATS_KEY]) Object.assign(stats, o[STATS_KEY]);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */
  const isEl = (n) => n instanceof Element;
  function matchesAny(el, sel) { return isEl(el) && el.matches(sel); }
  function selNotHost(el) {
    if (!isEl(el)) return true;
    for (const s of S.notHost) if (el.matches(s)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Overlay chrome (filter bar, keymap, fatal, status, extra-css injector)
   * Purely presentational; pointer-events:none so it never blocks X content.
   * ------------------------------------------------------------------ */
  function ensureOverlay() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'gridx-root';
    root.innerHTML = `
      <div id="gridx-filterbar">
        <span class="gx-fb-tag">filter:</span>
        <input id="gridx-filter-input" type="text"
          placeholder="terms hide posts · -term keeps only those · Enter apply · Esc clear"
          autocomplete="off" spellcheck="false" />
      </div>
      <div id="gridx-keymap" hidden>
        <h2>GridX keyboard map</h2>
        <table>
          <tr><td>j / k · ↓ / ↑</td><td>next / previous post</td></tr>
          <tr><td>g / G</td><td>top / bottom</td></tr>
          <tr><td>d / u</td><td>half page down / up</td></tr>
          <tr><td>Space / Shift+Space</td><td>page down / up</td></tr>
          <tr><td>Enter</td><td>open post in a new tab</td></tr>
          <tr><td>o</td><td>open post in same tab</td></tr>
          <tr><td>Backspace</td><td>go back</td></tr>
          <tr><td>f / s / p</td><td>focus filter / scan / pause</td></tr>
          <tr><td>? / Esc</td><td>keymap overlay / close</td></tr>
          <tr><td>Click post</td><td>open the real post in a new tab</td></tr>
        </table>
        <p class="gx-km-note">Keys are ignored while typing.</p>
      </div>
      <div id="gridx-fatal" hidden>
        <h1>GridX: timeline not found</h1>
        <p>GridX could not locate the timeline container on this page.</p>
        <p>This usually means X shipped a markup change, or you are not on a feed.</p>
        <button id="gridx-fatal-close">Close GridX</button>
      </div>
      <div id="gridx-statusbar"><span class="gx-hints"></span><span class="gx-stats"></span></div>
    `;
    document.body.appendChild(root);

    filterInput = root.querySelector('#gridx-filter-input');
    hintsEl = root.querySelector('.gx-hints');
    statsEl = root.querySelector('.gx-stats');
    keymapEl = root.querySelector('#gridx-keymap');
    fatalEl = root.querySelector('#gridx-fatal');

    filterInput.addEventListener('input', () => setKeywordFilter(previewTerms(), true));
    filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); filterInput.blur(); setKeywordFilter(previewTerms(), false); setStatus('filter applied'); }
      else if (e.key === 'Escape') { e.preventDefault(); clearFilter('cleared filter'); }
    });
    root.querySelector('#gridx-fatal-close').addEventListener('click', () => deactivate());
  }

  function ensureExtraCssEl() {
    let el = document.getElementById('gridx-extra-css');
    if (!el) { el = document.createElement('style'); el.id = 'gridx-extra-css'; document.head.appendChild(el); }
    return el;
  }

  /* ------------------------------------------------------------------ *
   * Stream-host detection.
   * Finds the container whose direct children each wrap the tweets (X's own
   * timeline div, or the fixture's #stream). Returns null if none — the grid
   * then stays off and we never break X.
   * ------------------------------------------------------------------ */
  function isStreamHost(el) {
    if (!isEl(el) || selNotHost(el)) return false;
    const kids = Array.from(el.children);
    if (kids.length < 3) return false;
    let withArticle = 0;
    for (const k of kids) {
      // A child may be the tweet itself (fixture) or a wrapper that CONTAINS
      // one (X's [data-testid="cellInnerDiv"]). Check both.
      if (k.matches && k.matches(ARTICLE)) withArticle++;
      else if (k.querySelector && k.querySelector(ARTICLE)) withArticle++;
    }
    return withArticle >= 2 && withArticle >= kids.length * 0.5;
  }

  function findHost() {
    const first = document.querySelector(ARTICLE);
    if (!first) return null;
    let el = first.parentElement;
    while (el && el !== document.documentElement) {
      if (isStreamHost(el)) return el;
      // skip single-article wrappers (X's [data-testid="cellInnerDiv"])
      el = el.parentElement;
    }
    // fallback: nearest scrollable ancestor of the first article
    let s = first.parentElement;
    while (s && !(s.scrollWidth > s.clientWidth || s.scrollHeight > s.clientHeight)) s = s.parentElement;
    return s && s !== document.documentElement ? s : null;
  }

  /* ------------------------------------------------------------------ *
   * Host grid application
   * ------------------------------------------------------------------ */
  function applyGrid() {
    if (!host) return;
    const cols = clampInt(settings.columnCount, 1, 8);
    stats.columnCount = cols;
    const gap = (settings.bleed ? 0 : 6) * densityScale();

    // Capture + apply inline styles. We mutate the host minimally and keep a
    // snapshot so `deactivate()` can restore X exactly.
    host.classList.add('gx-stream');
    host.setAttribute('data-gx-stream', '1');
    setInline('display', 'grid');
    setInline('gridTemplateColumns', 'repeat(' + cols + ', minmax(0, 1fr))');
    setInline('alignContent', 'start');
    setInline('alignItems', 'start');
    setInline('columnGap', gap + 'px');
    setInline('rowGap', gap + 'px');
    setInline('overflowY', 'auto');
    setInline('overflowX', 'hidden');
    setInline('overscrollBehavior', 'contain');
    setInline('scrollBehavior', 'auto');
    // Make sure the grid has room to scroll within the viewport. If the host
    // is already a scroller (real X), leave its height alone; otherwise (e.g.
    // the flat fixture `#stream`) constrain it so vertical scrolling works.
    if (host.scrollHeight <= host.clientHeight) setInline('height', '100vh');

    // Density / font-scale as CSS vars cascading into articles.
    const fs = clampNum(settings.fontScale, 0.8, 1.4);
    document.documentElement.style.setProperty('--gx-font-scale', fs.toFixed(2));
    document.documentElement.style.setProperty('--gx-density', densityScale().toFixed(2));
    document.documentElement.classList.toggle('gx-hide-avatar', settings.showAvatars === false);
    document.documentElement.classList.toggle('gx-hide-media', settings.showMedia === false);
    document.documentElement.classList.toggle('gx-hide-metrics', settings.showMetrics === false);
    document.documentElement.classList.toggle('gx-hide-promoted', !!settings.hidePromoted);
    document.documentElement.classList.toggle('gx-hide-rt', !!settings.hideRetweets);
    document.documentElement.classList.toggle('gx-hide-verified', !!settings.hideVerified);
    document.documentElement.classList.toggle('gx-bleed', !!settings.bleed);

    applyScanClass();
  }

  function densityScale() {
    return { compact: 1, cozy: 1.35, roomy: 1.75 }[settings.density] || 1;
  }

  function setInline(prop, value) {
    if (savedStyles && !(prop in savedStyles)) savedStyles[prop] = host.style[prop] || '';
    host.style[prop] = value;
  }

  function restoreHost() {
    if (!host || !savedStyles) return;
    for (const prop of Object.keys(savedStyles)) {
      if (savedStyles[prop] === '') host.style.removeProperty(prop);
      else host.style[prop] = savedStyles[prop];
    }
    host.classList.remove('gx-stream');
    host.removeAttribute('data-gx-stream');
    savedStyles = null;
  }

  /* ------------------------------------------------------------------ *
   * Per-article markings + filters (no re-parenting, no removal)
   * ------------------------------------------------------------------ */
  function markArticle(a) {
    if (!a.dataset.gxUrl) {
      const link = a.querySelector(STATUS_LINK);
      if (link) a.dataset.gxUrl = link.href;
    }
  }

  function articles() {
    return host ? Array.from(host.querySelectorAll(ARTICLE)) : [];
  }

  function isSponsor(a) { return !!a.querySelector(S.sponsored.join(', ')); }
  function isRetweeted(a) { return /reposted/i.test(a.innerText || ''); }
  function isVerified(a) { return !!a.querySelector(S.verified.join(', ')); }

  function termHides(text, terms) {
    for (const raw of terms || []) {
      const t = (raw || '').trim().toLowerCase();
      if (!t) continue;
      if (t[0] === '-') { const rest = t.slice(1); if (rest && !text.includes(rest)) return true; }
      else if (text.includes(t)) return true;
    }
    return false;
  }

  function recomputeFilters() {
    if (!host) return;
    let hidden = 0;
    for (const a of articles()) {
      markArticle(a);
      const text = (a.innerText || a.textContent || '').toLowerCase();
      const kw = termHides(text, settings.filterKeywords);
      const hf = termHides(text, settings.filterHandles);
      const catHide =
        (settings.hidePromoted && isSponsor(a)) ||
        (settings.hideRetweets && isRetweeted(a)) ||
        (settings.hideVerified && isVerified(a));
      const hide = kw || hf || catHide;
      a.classList.toggle('gx-hidden', hide);
      if (hide) hidden++;
    }
    stats.postsFiltered = hidden;
    stats.postsRendered = articles().length;
    updateStatsReadout();
  }

  /* ------------------------------------------------------------------ *
   * Observer: react to X appending/removing articles without moving them.
   * We only re-tag + re-filter. X's own virtualization does the rest.
   * ------------------------------------------------------------------ */
  function wireObserver() {
    if (!host) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (paused) return;
      // The stream container can be replaced by X; re-resolve if it moved.
      const now = findHost();
      if (now && now !== host) { detachObserver(); host = now; savedStyles = null; ensureOverlay(); applyGrid(); wireObserver(); }
      recomputeFilters();
    });
    observer.observe(host, { childList: true, subtree: true });
  }
  function detachObserver() { if (observer) { observer.disconnect(); observer = null; } }

  /* ------------------------------------------------------------------ *
   * Click-to-open: user asked clicks on a post open the REAL post in a new
   * tab. We only act when the click is not on a native link/interactive
   * control, and we open via a real <a> so it is a genuine user gesture.
   * ------------------------------------------------------------------ */
  function onClick(e) {
    if (paused) return;
    if (e.defaultPrevented) return;
    // Let X handle links, buttons, media controls, inputs natively.
    const interactive = e.target.closest(
      'a, [role="link"], [role="button"], button, [tabindex], input, textarea, video, audio, img, select'
    );
    if (interactive) return;
    const art = e.target.closest(ARTICLE);
    if (!art) return;
    const url = art.dataset.gxUrl || (() => {
      const l = art.querySelector(STATUS_LINK); return l ? l.href : '';
    })();
    if (!url) return;
    e.preventDefault();
    openTab(url);
  }

  function openTab(url) {
    // One method, one tab. window.open(..., 'noopener') returns null by design
    // (no cross-origin ref) which would wrongly look like a "failure" and cause
    // a double-open if we also fired an anchor. Using a real <a>.click() in a
    // user-gesture is reliable; the deferred removal lets navigation start
    // (an immediate remove() can cancel it).
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.setProperty('display', 'none');
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch (e) {} }, 100);
  }

  /* ------------------------------------------------------------------ *
   * Activation / teardown
   * ------------------------------------------------------------------ */
  let retryTimer = null;
  function activate() {
    if (active) return;
    ensureOverlay();
    hideFatal();
    host = findHost();
    if (!host) {
      showFatal('GridX: no timeline container found yet. Retrying…');
      scheduleRetry();
      return;
    }
    active = true;
    document.documentElement.classList.add(CLASS_ACTIVE);
    savedStyles = {};
    applyGrid();
    recomputeFilters();
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    startStats();
    setStatus('GridX active');
    log('activated on', host);
  }

  function wireToHost() {
    // (retained as a no-op for call-site clarity; handlers are document-level)
  }

  function scheduleRetry() {
    if (retryTimer) return;
    let tries = 0;
    retryTimer = setInterval(() => {
      tries++;
      if (findHost()) { clearInterval(retryTimer); retryTimer = null; if (!active) activate(); return; }
      if (tries > 10) { clearInterval(retryTimer); retryTimer = null; if (root && !active) showFatal('GridX: could not find the timeline after several attempts.'); }
    }, 1500);
  }

  function deactivate() {
    if (!active) return;
    detachObserver();
    stopStats();
    restoreHost();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.documentElement.classList.remove(CLASS_ACTIVE, CLASS_SCAN);
    replantAll();
    active = false;
    cursorArticle = null;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    log('deactivated');
  }

  // On toggle-off we leave X's DOM exactly as-is (we never changed it beyond
  // classes/inline styles already restored). Nothing to move back.
  function replantAll() { /* no-op in re-flow architecture: X is untouched */ }

  function showFatal(msg) {
    if (!fatalEl) return;
    const ps = fatalEl.querySelectorAll('p');
    if (msg && ps[1]) ps[1].textContent = msg;
    fatalEl.hidden = false;
  }
  function hideFatal() { if (fatalEl) fatalEl.hidden = true; }

  /* ------------------------------------------------------------------ *
   * Stats + status
   * ------------------------------------------------------------------ */
  function startStats() {
    if (statTimer) clearInterval(statTimer);
    statTimer = setInterval(() => {
      if (!paused) stats.gridActiveMs += 1000;
      updateStatsReadout();
      persistCounters();
    }, 1000);
  }
  function stopStats() {
    if (statTimer) { clearInterval(statTimer); statTimer = null; }
    updateStatsReadout(); persistCounters();
  }
  function fmtTime(ms) {
    let s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
  }
  function updateStatsReadout() {
    if (!statsEl) return;
    statsEl.textContent =
      'posts ' + stats.postsRendered +
      ' · hidden ' + stats.postsFiltered +
      ' · cols ' + stats.columnCount +
      ' · up ' + fmtTime(stats.gridActiveMs) +
      (paused ? ' · paused' : '') +
      (settings.scanMode ? ' · scan' : '');
  }
  function setStatus(text, ms = 2500) {
    if (!hintsEl) return;
    hintsEl.textContent = text;
    if (lastStatusTimer) clearTimeout(lastStatusTimer);
    if (ms > 0) lastStatusTimer = setTimeout(() => { if (hintsEl) hintsEl.textContent = ''; }, ms);
  }

  /* ------------------------------------------------------------------ *
   * Filters (typeahead) controls
   * ------------------------------------------------------------------ */
  function previewTerms() {
    return (filterInput ? filterInput.value : '').split(/[\s,]+/).filter(Boolean);
  }
  function setKeywordFilter(terms, preview) {
    settings.filterKeywords = terms;
    const tag = root ? root.querySelector('.gx-fb-tag') : null;
    if (tag) tag.textContent = terms.length ? 'filter(' + terms.length + '):' : 'filter:';
    recomputeFilters();
    saveSettings();
    log('filter', terms, preview ? '(preview)' : '(applied)');
  }
  function clearFilter(msg) {
    if (filterInput) filterInput.value = '';
    settings.filterKeywords = [];
    setKeywordFilter([], false);
    if (msg) setStatus(msg);
  }

  /* ------------------------------------------------------------------ *
   * CSS var + scan classes applied to <html>
   * ------------------------------------------------------------------ */
  function applyScanClass() {
    document.documentElement.classList.toggle(CLASS_SCAN, !!settings.scanMode);
    // extra CSS injection
    try { ensureExtraCssEl().textContent = settings.extraCss || ''; } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * Messaging (chrome.runtime + DOM custom events)
   * ------------------------------------------------------------------ */
  function applyMessage(detail) {
    if (!detail || typeof detail !== 'object') return;
    if ('scanMode' in detail) {
      if (detail.scanMode && !settings.scanMode) {
        prevSettings = pick(settings, SCAN_KEYS);
        Object.assign(settings, SCAN_OVERRIDES);
        settings.scanMode = true;
      } else if (!detail.scanMode && settings.scanMode) {
        const p = prevSettings || {};
        Object.assign(settings, p);
        settings.scanMode = false;
        prevSettings = null;
      } else settings.scanMode = !!detail.scanMode;
    }
    for (const k of Object.keys(detail)) if (k !== 'scanMode') settings[k] = detail[k];
    if (active) { applyGrid(); recomputeFilters(); }
    saveSettings();
  }

  function handleCommand(cmd) {
    if (cmd === 'toggle-grid') { if (active) deactivate(); else activate(); }
    else if (cmd === 'toggle-pause') togglePause();
    else if (cmd === 'toggle-scan') toggleScan();
  }

  function registerMessaging() {
    try {
      chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'gridx:update') { applyMessage(msg.settings || {}); sendResponse({ ok: true }); }
        else if (msg.type === 'gridx:command') { handleCommand(msg.payload); sendResponse({ ok: true }); }
        else if (msg.type === 'gridx:getState') { sendResponse(getState()); }
        return true;
      });
    } catch (e) { log('chrome messaging unavailable', e); }
    document.addEventListener('gridx:update', (e) => applyMessage(e.detail || {}));
    document.addEventListener('gridx:command', (e) => handleCommand(e.detail));
    document.addEventListener('gridx:getState', (e) => {
      document.dispatchEvent(new CustomEvent('gridx:state', { detail: getState() }));
    });
  }

  /* ------------------------------------------------------------------ *
   * Scan / pause
   * ------------------------------------------------------------------ */
  function toggleScan() { applyMessage({ scanMode: !settings.scanMode }); setStatus(settings.scanMode ? 'scan ON' : 'scan OFF'); }
  function togglePause() {
    paused = !paused;
    document.documentElement.classList.toggle('gx-paused', paused);
    const h = host;
    if (paused) { h && h.classList.add('gx-paused'); detachObserver(); }
    else { h && h.classList.remove('gx-paused'); wireObserver(); }
    setStatus(paused ? 'paused' : 'resumed');
    updateStatsReadout();
  }

  /* ------------------------------------------------------------------ *
   * Keyboard navigation (vim-flavored; in content script so any key binds)
   * ------------------------------------------------------------------ */
  const isEditable = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  function list() {
    return (host ? Array.from(host.querySelectorAll(ARTICLE)) : []).filter(a => !a.classList.contains('gx-hidden'));
  }
  function idx(a) { return list().indexOf(a); }
  function focus(a) {
    if (!a) return;
    if (cursorArticle) cursorArticle.classList.remove('gx-cursor');
    cursorArticle = a; a.classList.add('gx-cursor');
    a.scrollIntoView({ block: 'nearest' });
  }
  function move(delta) {
    const l = list(); if (!l.length) return;
    const i = idx(cursorArticle);
    focus(l[i < 0 ? 0 : Math.max(0, Math.min(l.length - 1, i + delta))]);
  }
  function scrollBy(f) { if (host) host.scrollTop += f * (host.clientHeight || 900); }
  function openCursor(sameTab) {
    const a = cursorArticle;
    const url = a ? (a.dataset.gxUrl || '') : '';
    if (!url) { setStatus('no post under cursor'); return; }
    if (sameTab) window.location.href = url; else openTab(url);
  }
  function toggleCursor() { if (cursorArticle) cursorArticle.classList.toggle('gx-expanded'); }
  function toggleKeymap() { if (keymapEl) keymapEl.hidden = !keymapEl.hidden; }
  function clearCursorOrClose() {
    if (keymapEl && !keymapEl.hidden) { keymapEl.hidden = true; return; }
    if (cursorArticle) { cursorArticle.classList.remove('gx-cursor'); cursorArticle = null; setStatus('cursor cleared'); }
  }

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (isEditable(t)) {
      if (t === filterInput && e.key === 'Escape') { e.preventDefault(); clearFilter('cleared filter'); }
      return;
    }
    const shift = e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'j': case 'ArrowDown': move(1); break;
      case 'k': case 'ArrowUp': move(-1); break;
      case 'g': move(-10000000); break;
      case 'G': move(10000000); break;
      case 'd': scrollBy(0.5); break;
      case 'u': scrollBy(shift ? -1 : -0.5); break;
      case ' ': e.preventDefault(); scrollBy(shift ? -1 : 1); break;
      case 'Enter': openCursor(false); break;
      case 'o': openCursor(true); break;
      case 'Backspace': window.history.back(); break;
      case 'x': toggleCursor(); break;
      case 'f': if (filterInput) { filterInput.focus(); filterInput.select(); } break;
      case 's': toggleScan(); break;
      case 'p': togglePause(); break;
      case '?': toggleKeymap(); break;
      case 'Escape': clearCursorOrClose(); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); }
  }

  /* ------------------------------------------------------------------ *
   * State snapshot for popup/options
   * ------------------------------------------------------------------ */
  function getState() {
    recomputeFilters();
    return {
      active, paused, scanMode: settings.scanMode,
      columnCount: settings.columnCount, density: settings.density,
      fontScale: settings.fontScale,
      postsRendered: stats.postsRendered, postsFiltered: stats.postsFiltered,
      gridActiveMs: stats.gridActiveMs,
      hidePromoted: settings.hidePromoted, hideRetweets: settings.hideRetweets,
    };
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  async function init() {
    await loadCounters();
    await loadSettings();
    registerMessaging();
    activate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();