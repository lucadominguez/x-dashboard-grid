/* ============================================================================
 * GridX content script
 * ----------------------------------------------------------------------------
 * Strategy: "DOM hoisting", fully read-only with respect to Twitter/X's data.
 *
 *  - We never call the X API, never read cookies, never write replies/RTs,
 *    never programmatically scroll or auto-fetch. We take the articles X has
 *    already rendered and re-parent them into our own #gridx-root CSS grid.
 *  - The source of truth stays X's DOM. X is the owner: a MutationObserver on
 *    the primary column reacts to X's infinite-scroll additions/removals.
 *  - Removed articles go to a hidden STASH, not to GC, because X's React event
 *    handlers / observers still hold references to those nodes. Destroying them
 *    could make X throw. Stashing keeps the exact node alive and lets us
 *    re-parent the SAME node back into the grid if X re-inserts it.
 *  - Selectors are layered fallbacks because X's markup churns. If nothing
 *    matches, we show a clear overlay and never break X.
 *  - We run in the ISOLATED world. We style our own wrapper classes
 *    (#gridx-root, .gx-cell) and use !important where X's styles would fight
 *    us. We do not depend on any of X's class names for styling.
 *  - Settings live in chrome.storage.local under one `gridxSettings` object.
 *
 * Debug logging is behind settings.debug and always prefixed [gridx].
 * ========================================================================== */
(() => {
  'use strict';

  const NS = 'gridx';
  const CLASS_ACTIVE = 'gridx-active';
  const CLASS_SCAN = 'gridx-scan';
  const STORAGE_KEY = 'gridxSettings';
  const STATS_KEY = 'gridxStats';

  /* ------------------------------------------------------------------ *
   * Defaults & selector candidates (layered fallbacks).
   * Each list is ordered; we feature-detect / matches() any of them.
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
    // Primary timeline container. X has replaced many selectors over the years;
    // keep several layers.
    primaryColumn: [
      '[data-testid="primaryColumn"]',
      'main section',
      'main[role="main"]',
    ],
    article: ['article[data-testid="tweet"]', 'article'],
    statusLink: ['a[href*="/status/"]'],
    avatar: ['[data-testid="UserAvatar-Container"] img', 'img[src*="profile_images"]'],
    tweetText: ['[data-testid="tweetText"]'],
    actions: ['[role="group"]'],
    sponsored: ['a[aria-label*="sponsored"]'],
    tweetPhoto: ['[data-testid="tweetPhoto"]'],
    video: ['[data-testid="videoPlayer"]', 'video'],
    tombstone: ['[data-testid="tombstone"]'], // quoted-tweet container
    verified: ['[data-testid="icon-verified"]', 'svg[aria-label*="Verified"]'],
  };

  const SCAN_KEYS = [
    'columnCount', 'density', 'showAvatars', 'showMedia', 'showMetrics', 'fontScale',
  ];
  // Scan = absolute maximum information transfer.
  const SCAN_OVERRIDES = {
    columnCount: 8,
    density: 'compact',
    showAvatars: false,
    showMedia: false,
    showMetrics: false,
    fontScale: 0.9,
  };

  const ARTICLE_MATCHER = S.article.join(', ');
  const STATUS_LINK_MATCHER = S.statusLink.join(', ');
  const PHOTO_MATCHER = S.tweetPhoto.join(', ');
  const VIDEO_MATCHER = S.video.join(', ');
  const SPONSORED_MATCHER = S.sponsored.join(', ');
  const TOMBSTONE_MATCHER = S.tombstone.join(', ');

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  let settings = { ...DEFAULTS };
  let active = false;
  let paused = false;
  let primaryEl = null;
  let observer = null;
  let root = null;
  let filterBar = null;
  let filterInput = null;
  let statusBar = null;
  let hintsEl = null;
  let statsEl = null;
  let keymapEl = null;
  let stashEl = null;
  let fatalEl = null;
  let extraCssEl = null;
  let cellRegistry = null; // WeakMap<article, cell>
  let cursorCell = null;
  let prevSettings = null; // pre-scan snapshot for restore
  let statTimer = null;
  let lastStatusTimer = null;
  let lastFilterValue = '';

  const stats = { postsRendered: 0, postsFiltered: 0, gridActiveMs: 0, columnCount: 3 };

  const log = (...a) => { if (settings.debug) console.log('[' + NS + ']', ...a); };
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || lo)));
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || lo));
  const pick = (obj, keys) => { const o = {}; for (const k of keys) o[k] = obj[k]; return o; };

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */
  async function loadSettings() {
    try {
      const o = await chrome.storage.local.get(STORAGE_KEY);
      settings = { ...DEFAULTS, ...(o[STORAGE_KEY] || {}) };
    } catch (e) {
      settings = { ...DEFAULTS };
      log('storage unavailable, using defaults', e);
    }
  }

  function saveSettings() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: settings }); } catch (e) { /* noop */ }
  }

  function persistCounters() {
    try { chrome.storage.local.set({ [STATS_KEY]: { ...stats } }); } catch (e) { /* noop */ }
  }

  async function loadCounters() {
    try {
      const o = await chrome.storage.local.get(STATS_KEY);
      if (o[STATS_KEY]) {
        stats.postsRendered = o[STATS_KEY].postsRendered || 0;
        stats.postsFiltered = o[STATS_KEY].postsFiltered || 0;
        stats.gridActiveMs = o[STATS_KEY].gridActiveMs || 0;
      }
    } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------------ *
   * Selector helpers
   * ------------------------------------------------------------------ */
  const elMatches = (el, sel) => (el instanceof Element) && sel && el.matches(sel);
  function isArticle(el) { return elMatches(el, ARTICLE_MATCHER); }
  function findPrimary() {
    for (const sel of S.primaryColumn) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function hasAny(article, sel) {
    if (!article) return false;
    return sel && (article.matches(sel) || article.querySelector(sel) != null);
  }
  function primaryUrl(article) {
    const a = article.querySelector(STATUS_LINK_MATCHER);
    return a ? a.href : '';
  }
  function isSponsor(article) { return hasAny(article, SPONSORED_MATCHER); }
  function isVideo(article) { return hasAny(article, VIDEO_MATCHER); }
  function isImage(article) { return hasAny(article, PHOTO_MATCHER); }
  function isQuote(article) { return hasAny(article, TOMBSTONE_MATCHER); }
  function isVerified(article) { return hasAny(article, S.verified.join(', ')); }
  function isRetweet(article) {
    return article && /reposted|repost/i.test(article.innerText || '');
  }
  function repostUser(article) {
    const m = /reposted[\s\S]{0,40}?@?([A-Za-z0-9_.]{1,50})/i.exec(article.innerText || '');
    return m ? '@' + m[1] : '';
  }
  function mediaType(article) {
    if (isVideo(article)) return 'video';
    const img = article.querySelector(PHOTO_MATCHER + ' img');
    const src = (img && (img.src || '')) || '';
    if (/\.gif/i.test(src) || /prfx|media.*gif/i.test(src)) return 'gif';
    return 'image';
  }

  /* ------------------------------------------------------------------ *
   * DOM scaffolding
   * ------------------------------------------------------------------ */
  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'gridx-root';
    root.innerHTML = `
      <div id="gridx-filterbar">
        <span class="gx-fb-tag">filter:</span>
        <input id="gridx-filter-input" type="text" placeholder="terms hide posts · -term = only those · Enter apply · Esc clear" autocomplete="off" spellcheck="false" />
      </div>
      <div id="gridx-statusbar">
        <span class="gx-hints"></span>
        <span class="gx-stats"></span>
      </div>
      <div id="gridx-keymap" hidden>
        <h2>GridX keyboard map</h2>
        <table>
          <tr><td>j / k</td><td>next / previous post</td></tr>
          <tr><td>↓ / ↑</td><td>next / previous post</td></tr>
          <tr><td>h / l</td><td>previous / next column</td></tr>
          <tr><td>g / G</td><td>top / bottom</td></tr>
          <tr><td>d / u</td><td>half page down / up</td></tr>
          <tr><td>Space / Shift+Space</td><td>page down / up</td></tr>
          <tr><td>Enter</td><td>open current post in a new tab</td></tr>
          <tr><td>o</td><td>open current post in the same tab</td></tr>
          <tr><td>Backspace</td><td>go back</td></tr>
          <tr><td>x</td><td>expand / collapse current post text</td></tr>
          <tr><td>m</td><td>toggle media on current post</td></tr>
          <tr><td>f</td><td>focus filter bar</td></tr>
          <tr><td>s</td><td>toggle scan mode</td></tr>
          <tr><td>p</td><td>pause / resume grid</td></tr>
          <tr><td>?</td><td>show / hide this overlay</td></tr>
          <tr><td>Esc</td><td>close overlay / clear cursor</td></tr>
        </table>
        <p style="font-size:11px;color:var(--gx-muted)">Keys are ignored while typing in a text field.</p>
      </div>
      <div id="gridx-fatal" hidden>
        <h1>GridX: timeline not found</h1>
        <p>GridX could not locate the primary column or tweet articles on this page.</p>
        <p>This usually means X shipped a markup change, or you are on a page without a feed.</p>
        <button id="gridx-fatal-close">Close GridX</button>
      </div>
      <div id="gridx-stash"></div>
    `;
    document.body.appendChild(root);

    filterBar = root.querySelector('#gridx-filterbar');
    filterInput = root.querySelector('#gridx-filter-input');
    statusBar = root.querySelector('#gridx-statusbar');
    hintsEl = root.querySelector('.gx-hints');
    statsEl = root.querySelector('.gx-stats');
    keymapEl = root.querySelector('#gridx-keymap');
    stashEl = root.querySelector('#gridx-stash');
    fatalEl = root.querySelector('#gridx-fatal');
    cellRegistry = new WeakMap();

    filterInput.addEventListener('input', () => {
      // Live demo of keyword matching while typing (applied on Enter, but we
      // preview the hide-set here so typing feels responsive).
      setKeywordFilter(previewTerms());
    });
    filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        filterInput.blur();
        setKeywordFilter(previewTerms());
        setStatus('filter applied');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearFilter('cleared filter');
      }
    });

    root.addEventListener('click', (e) => {
      const chip = e.target.closest('.gx-chip-media');
      if (chip) {
        e.preventDefault(); e.stopPropagation();
        const cell = chip.closest('.gx-cell');
        if (cell) toggleMedia(cell);
        return;
      }
      const ovf = e.target.closest('.gx-overflow');
      if (ovf) {
        e.preventDefault(); e.stopPropagation();
        const cell = ovf.closest('.gx-cell');
        if (cell) toggleExpand(cell);
        return;
      }
      const cell = e.target.closest('.gx-cell');
      if (!cell) return;
      // Ignore clicks that land on a link or interactive X control.
      if (e.target.closest('a, [role="link"], [role="button"], video, img, input, textarea')) return;
      toggleExpand(cell);
    });

    const closeBtn = root.querySelector('#gridx-fatal-close');
    closeBtn.addEventListener('click', () => { deactivate(); });
  }

  function showFatal(msg) {
    if (!root) return;
    const p = fatalEl.querySelectorAll('p');
    if (msg && p[1]) p[1].textContent = msg;
    fatalEl.hidden = false;
  }
  function hideFatal() { if (fatalEl) fatalEl.hidden = true; }

  /* ------------------------------------------------------------------ *
   * Cell creation (annotations + re-parenting)
   * ------------------------------------------------------------------ */
  function addChip(cell, text, cls) {
    const c = document.createElement('span');
    c.className = 'gx-chip ' + (cls || '');
    c.textContent = text;
    cell.appendChild(c);
    return c;
  }

  function makeCell(article) {
    const cell = document.createElement('div');
    cell.className = 'gx-cell';
    cell.dataset.gxCell = '1';
    const url = primaryUrl(article);
    if (url) cell.dataset.gxUrl = url;

    // Annotation badges BEFORE the article so they read as a meta row.
    if (isRetweet(article)) {
      cell.classList.add('gx-rt');
      addChip(cell, '↻ ' + repostUser(article), 'gx-chip-rt');
    }
    if (isSponsor(article)) {
      cell.classList.add('gx-ad');
      addChip(cell, 'AD', 'gx-chip-ad');
    }
    if (isImage(article) || isVideo(article)) {
      cell.classList.add('gx-media');
      addChip(cell, '[' + mediaType(article) + ']', 'gx-chip-media');
    }
    if (isVerified(article)) cell.classList.add('gx-verified');
    if (isQuote(article)) addChip(cell, '❝ quote', 'gx-chip-quote');

    // Overflow button, top-right.
    const ovf = document.createElement('button');
    ovf.className = 'gx-overflow';
    ovf.setAttribute('aria-label', 'More');
    ovf.textContent = '≡';
    cell.appendChild(ovf);

    // Re-parent the SAME article node. X remains the source of truth.
    article.dataset.gxHoisted = '1';
    cell.appendChild(article);
    return cell;
  }

  function ensureCellFor(article) {
    if (cellRegistry.has(article)) {
      const c = cellRegistry.get(article);
      if (c && c.isConnected) return c;
    }
    const c = makeCell(article);
    cellRegistry.set(article, c);
    return c;
  }

  /* ------------------------------------------------------------------ *
   * Hoisting / stashing
   * ------------------------------------------------------------------ */
  function hoistArticle(article) {
    // If the article already lives inside our grid, nothing to do (save for a
    // filter refresh). Otherwise (re-)wrap and re-parent.
    if (root.contains(article)) { refreshCellFor(article); return; }
    const cell = ensureCellFor(article);
    if (!root.contains(cell)) root.appendChild(cell);
    cell.dataset.gxUrl = primaryUrl(article) || cell.dataset.gxUrl || '';
    refreshCellFor(article);
  }

  function refreshCellFor(article) {
    // Recompute visibility + keep annotations fresh if the node changed.
    const cell = cellRegistry.get(article);
    if (!cell) return;
    cell.classList.toggle('gx-ad', isSponsor(article));
    if (cell.querySelector('.gx-chip-media')) {
      cell.querySelector('.gx-chip-media').textContent = '[' + mediaType(article) + ']';
    }
  }

  function stashArticle(article) {
    // Park the node, do not destroy it (X's observer contract).
    if (article.parentElement && article.parentElement.classList.contains('gx-cell')) {
      article.parentElement.remove();
    }
    stashEl.appendChild(article);
  }

  function collectArticles(container) {
    return Array.from(container.querySelectorAll(ARTICLE_MATCHER));
  }

  function hoistAll(pc) {
    for (const a of collectArticles(pc)) hoistArticle(a);
    updateFilters();
    updateStatsReadout();
  }

  /* ------------------------------------------------------------------ *
   * MutationObserver (X owns the DOM; we react and re-parent)
   * ------------------------------------------------------------------ */
  function wireObserver(pc) {
    if (observer) observer.disconnect();
    primaryEl = pc;
    observer = new MutationObserver(onMutate);
    observer.observe(pc, { childList: true, subtree: true });
  }

  function onMutate(records) {
    if (paused) return; // paused = observer disconnected anyway
    const pc = findPrimary();
    if (pc && pc !== primaryEl) {
      // X replaced the primary container wholesale.
      wireObserver(pc);
      hoistAll(pc);
    }
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (!(node instanceof Element)) continue;
        handleAdded(node);
      }
      for (const node of rec.removedNodes) {
        if (!(node instanceof Element)) continue;
        handleRemoved(node);
      }
    }
    updateFilters();
    updateStatsReadout();
  }

  function handleAdded(node) {
    if (isArticle(node)) { handleAddedArticle(node); return; }
    for (const a of node.querySelectorAll(ARTICLE_MATCHER)) handleAddedArticle(a);
  }

  function handleAddedArticle(a) {
    if (a.dataset.gxHoisting === '1') return; // our own mid-move
    if (a.dataset.gxHoisted === '1') {
      // X re-inserted a node we know. If it's not already in our grid, re-hoist
      // the exact same node from the stash (source-of-truth stays X).
      if (!root.contains(a)) hoistArticle(a);
      return;
    }
    hoistArticle(a);
  }

  function handleRemoved(node) {
    if (isArticle(node)) { handleRemovedArticle(node); return; }
    for (const a of node.querySelectorAll(ARTICLE_MATCHER)) handleRemovedArticle(a);
  }

  function handleRemovedArticle(a) {
    if (a.dataset.gxHoisted !== '1') return; // never ours
    // If the node is already inside our grid, this removal is OUR OWN move
    // (we took it out of primaryColumn to put it in a cell) - ignore.
    if (root.contains(a)) return;
    stashArticle(a);
  }

  /* ------------------------------------------------------------------ *
   * Filters
   * ------------------------------------------------------------------ */
  const isEditableTarget = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  function previewTerms() {
    return (filterInput ? filterInput.value : lastFilterValue).split(/[\s,]+/).filter(Boolean);
  }

  function setKeywordFilter(terms) {
    settings.filterKeywords = terms;
    lastFilterValue = terms.join(' ');
    if (filterInput && filterInput.value !== lastFilterValue) filterInput.value = lastFilterValue;
    runFilters();
    persistFilterBadge();
    saveSettings();
  }
  function persistFilterBadge() {
    const tag = filterBar ? filterBar.querySelector('.gx-fb-tag') : null;
    if (!tag) return;
    tag.textContent = settings.filterKeywords.length
      ? 'filter(' + settings.filterKeywords.length + '):'
      : 'filter:';
  }
  function clearFilter(msg) {
    if (filterInput) filterInput.value = '';
    settings.filterKeywords = [];
    lastFilterValue = '';
    runFilters();
    persistFilterBadge();
    saveSettings();
    if (msg) setStatus(msg);
  }

  // Which words count as "matching" for a hide-term / keep-term.
  function termHides(text, terms) {
    for (const raw of terms || []) {
      const t = raw.trim().toLowerCase();
      if (!t) continue;
      if (t[0] === '-') {
        // "-term" = include-only: hide everything EXCEPT posts containing term.
        const rest = t.slice(1);
        if (rest && !text.includes(rest)) return true;
      } else if (text.includes(t)) {
        return true;
      }
    }
    return false;
  }

  function getCells() {
    return root ? Array.from(root.querySelectorAll('.gx-cell')) : [];
  }

  function updateFilters() {
    if (!root) return;
    let hidden = 0;
    for (const cell of getCells()) {
      const article = cell.querySelector(ARTICLE_MATCHER);
      if (!article) { cell.classList.add('gx-hidden'); hidden++; continue; }
      const text = (cell.textContent || '').toLowerCase();
      const kw = termHides(text, settings.filterKeywords);
      const hf = termHides(text, settings.filterHandles);
      const catHide =
        (settings.hidePromoted && cell.classList.contains('gx-ad')) ||
        (settings.hideRetweets && cell.classList.contains('gx-rt')) ||
        (settings.hideVerified && cell.classList.contains('gx-verified'));
      const hide = kw || hf || catHide;
      cell.classList.toggle('gx-hidden', hide);
      if (hide) hidden++;
    }
    stats.postsFiltered = hidden;
    stats.postsRendered = getCells().length;
  }
  const runFilters = updateFilters; // alias used by filter controls

  /* ------------------------------------------------------------------ *
   * Apply settings to DOM
   * ------------------------------------------------------------------ */
  function applyDom() {
    if (!root) return;

    const cols = clampInt(settings.columnCount, 1, 8);
    stats.columnCount = cols;
    root.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';

    const density = ['compact', 'cozy', 'roomy'].includes(settings.density) ? settings.density : 'compact';
    root.classList.remove('gx-d-compact', 'gx-d-cozy', 'gx-d-roomy');
    root.classList.add('gx-d-' + density);

    const fs = clampNum(settings.fontScale, 0.8, 1.4);
    root.style.setProperty('--gx-font-scale', fs.toFixed(2));

    root.classList.toggle('gx-hide-avatar', settings.showAvatars === false);
    root.classList.toggle('gx-hide-media', settings.showMedia === false);
    root.classList.toggle('gx-hide-metrics', settings.showMetrics === false);
    root.classList.toggle('gx-hide-promoted', !!settings.hidePromoted);
    root.classList.toggle('gx-hide-rt', !!settings.hideRetweets);
    root.classList.toggle('gx-hide-verified', !!settings.hideVerified);
    root.classList.toggle('gx-bleed', !!settings.bleed);
    root.classList.toggle('gx-scan', !!settings.scanMode);
    root.classList.toggle('gx-paused', paused);

    // Persist scan class at <html> level (smoke-test contract + CSS guard).
    document.documentElement.classList.toggle(CLASS_SCAN, !!settings.scanMode);

    injectExtraCss();
    updateFilters();
    updateStatsReadout();
  }

  function injectExtraCss() {
    if (!extraCssEl || !extraCssEl.isConnected) {
      extraCssEl = document.getElementById('gridx-extra-css');
      if (!extraCssEl) {
        extraCssEl = document.createElement('style');
        extraCssEl.id = 'gridx-extra-css';
        document.head.appendChild(extraCssEl);
      }
    }
    extraCssEl.textContent = settings.extraCss || '';
  }

  /* ------------------------------------------------------------------ *
   * Messaging (chrome.runtime + DOM custom events for the smoke test)
   * ------------------------------------------------------------------ */
  function applyMessage(detail) {
    if (!detail || typeof detail !== 'object') return;
    let touched = false;

    if ('scanMode' in detail) {
      touched = true;
      if (detail.scanMode && !settings.scanMode) {
        prevSettings = pick(settings, SCAN_KEYS);
        Object.assign(settings, SCAN_OVERRIDES);
        settings.scanMode = true;
        document.documentElement.classList.add(CLASS_SCAN);
      } else if (!detail.scanMode && settings.scanMode) {
        const p = prevSettings || {};
        Object.assign(settings, p);
        settings.scanMode = false;
        document.documentElement.classList.remove(CLASS_SCAN);
        prevSettings = null;
      } else {
        settings.scanMode = !!detail.scanMode;
      }
      // fallthrough may apply non-scan fields too
    }
    for (const k of Object.keys(detail)) {
      if (k === 'scanMode') continue;
      settings[k] = detail[k];
      touched = true;
    }
    if (root && touched) { applyDom(); }
    // Even if the grid isn't active yet, persist so activation uses the values.
    saveSettings();
  }

  function handleCommand(cmd) {
    if (cmd === 'toggle-grid') {
      if (active) deactivate(); else activate();
    } else if (cmd === 'toggle-pause') {
      togglePause();
    } else if (cmd === 'toggle-scan') {
      toggleScan();
    }
  }

  function registerMessaging() {
    // Real chrome messaging (popup / options / background).
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'gridx:update') { applyMessage(msg.settings || {}); sendResponse({ ok: true }); }
        else if (msg.type === 'gridx:command') { handleCommand(msg.payload); sendResponse({ ok: true }); }
        else if (msg.type === 'gridx:getState') { sendResponse(getState()); }
        return true; // allow async sendResponse if needed
      });
    } catch (e) { log('chrome messaging unavailable', e); }

    // DOM custom events so page scripts (and the Playwright smoke test) can
    // drive the extension in the shared DOM without needing the extension id.
    document.addEventListener('gridx:update', (e) => {
      applyMessage(e.detail || {});
    });
    document.addEventListener('gridx:command', (e) => {
      handleCommand(e.detail);
    });
    document.addEventListener('gridx:getState', (e) => {
      document.dispatchEvent(new CustomEvent('gridx:state', { detail: getState() }));
    });
  }

  /* ------------------------------------------------------------------ *
   * Activation / teardown
   * ------------------------------------------------------------------ */
  function activate() {
    if (active) return;
    ensureDom();
    hideFatal();
    const pc = findPrimary();
    if (!pc) {
      // Fail-safe: do not touch the page. Keep retrying in case X hydrates late.
      showFatal('GridX: detected a page but no primary timeline yet. Retrying…');
      scheduleRetry();
      return;
    }
    active = true;
    document.documentElement.classList.add(CLASS_ACTIVE);
    applyDom();
    hoistAll(pc);
    wireObserver(pc);
    startStats();
    setStatus('GridX active');
    log('activated');
  }

  let retryTimer = null;
  function scheduleRetry() {
    if (retryTimer) return;
    let tries = 0;
    retryTimer = setInterval(() => {
      tries++;
      if (findPrimary()) {
        clearInterval(retryTimer);
        retryTimer = null;
        if (!active) activate();
        return;
      }
      if (tries > 10) {
        clearInterval(retryTimer);
        retryTimer = null;
        if (root && !active) showFatal('GridX: could not find the timeline after several attempts.');
      }
    }, 1500);
  }

  function deactivate() {
    if (!active) return;
    stopStats();
    if (observer) { observer.disconnect(); observer = null; }
    primaryEl = null;
    revertToPage();
    if (root) { root.remove(); root = null; }
    document.documentElement.classList.remove(CLASS_ACTIVE, CLASS_SCAN);
    active = false;
    cursorCell = null;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    log('deactivated');
  }

  // Put X's articles back where X wants them, then drop the grid.
  function revertToPage() {
    const pc = findPrimary();
    if (!root) return;
    const seen = new Set();
    if (pc) collectArticles(pc).forEach((a) => seen.add(a));
    const putBack = (a) => { if (a && !seen.has(a)) { seen.add(a); if (pc) pc.appendChild(a); } };
    for (const cell of Array.from(root.querySelectorAll('.gx-cell'))) {
      const a = cell.querySelector(ARTICLE_MATCHER);
      putBack(a);
      cell.remove();
    }
    collectArticles(stashEl).forEach(putBack);
  }

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
    updateStatsReadout();
    persistCounters();
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
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

  function setStatus(text, ms = 2000) {
    if (!hintsEl) return;
    hintsEl.textContent = text;
    if (lastStatusTimer) clearTimeout(lastStatusTimer);
    if (ms > 0) {
      lastStatusTimer = setTimeout(() => { if (hintsEl) hintsEl.textContent = ''; }, ms);
    }
  }

  function getState() {
    updateFilters();
    updateStatsReadout();
    return {
      active,
      paused,
      scanMode: settings.scanMode,
      columnCount: settings.columnCount,
      density: settings.density,
      fontScale: settings.fontScale,
      postsRendered: stats.postsRendered,
      postsFiltered: stats.postsFiltered,
      gridActiveMs: stats.gridActiveMs,
      hidePromoted: settings.hidePromoted,
      hideRetweets: settings.hideRetweets,
    };
  }

  /* ------------------------------------------------------------------ *
   * Scan / pause toggles
   * ------------------------------------------------------------------ */
  function toggleScan() {
    applyMessage({ scanMode: !settings.scanMode });
    setStatus(settings.scanMode ? 'scan mode ON' : 'scan mode OFF');
  }
  function togglePause() {
    paused = !paused;
    if (root) {
      root.classList.toggle('gx-paused', paused);
      const pc = findPrimary();
      if (paused) { if (observer) observer.disconnect(); }
      else if (pc) wireObserver(pc);
    }
    setStatus(paused ? 'paused' : 'resumed');
    updateStatsReadout();
  }

  /* ------------------------------------------------------------------ *
   * Keyboard navigation (vim-flavored, in the content script so any key can
   * bind - independent of the `commands` API which is limited to a set.)
   * ------------------------------------------------------------------ */
  function currentCells() {
    return root ? Array.from(root.querySelectorAll('.gx-cell:not(.gx-hidden)')) : [];
  }
  function cellIndex(cell) {
    return currentCells().indexOf(cell);
  }
  function focusCell(cell) {
    if (!cell) return;
    if (cursorCell) cursorCell.classList.remove('gx-cursor');
    cursorCell = cell;
    cell.classList.add('gx-cursor');
    cell.scrollIntoView({ block: 'nearest' });
  }
  function moveCursor(delta) {
    const list = currentCells();
    if (!list.length) return;
    const i = cellIndex(cursorCell);
    const next = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
    focusCell(list[next]);
  }
  function moveColumn(delta) {
    const list = currentCells();
    if (!list.length) return;
    const i = cellIndex(cursorCell);
    if (i < 0) { focusCell(list[0]); return; }
    const cols = clampInt(settings.columnCount, 1, 8);
    const row = Math.floor(i / cols);
    const col = i % cols;
    const targetCol = col + delta;
    if (targetCol < 0 || targetCol >= cols) return;
    const targetRow = list.filter((c, idx) => Math.floor(idx / cols) === row);
    const inRow = list[Math.min(i + delta, list.length - 1)];
    // Prefer the exact (row, col) slot; fall back to nearest.
    const slot = row * cols + targetCol;
    const cell = slot < list.length && Math.floor(slot / cols) === row ? list[slot] : inRow;
    focusCell(cell);
  }
  function scrollByPage(f) {
    if (!root) return;
    root.scrollTop += f * root.clientHeight;
  }
  function openCursor(sameTab) {
    const cell = cursorCell;
    const url = cell ? (cell.dataset.gxUrl || '') : '';
    if (!url) { setStatus('no post under cursor'); return; }
    if (sameTab) {
      window.location.href = url;
    } else {
      // Real <a> click = user gesture + normal new-tab behavior.
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }
  function goBack() { window.history.back(); }
  function toggleExpand(cell) {
    if (!cell) return;
    cell.classList.toggle('gx-expanded');
  }
  function toggleMedia(cell) {
    if (!cell) return;
    cell.classList.toggle('gx-media-open');
  }
  function focusFilter() {
    if (filterInput) { filterInput.focus(); filterInput.select(); }
  }
  function toggleKeymap() {
    if (keymapEl) keymapEl.hidden = !keymapEl.hidden;
  }
  function clearCursorOrClose() {
    if (keymapEl && !keymapEl.hidden) { keymapEl.hidden = true; return; }
    if (cursorCell) { cursorCell.classList.remove('gx-cursor'); cursorCell = null; setStatus('cursor cleared'); }
  }

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (isEditableTarget(t)) {
      // Allow Esc to clear the filter while typing in it.
      if (t === filterInput && e.key === 'Escape') { e.preventDefault(); clearFilter('cleared filter'); }
      return;
    }
    const shift = e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'j': case 'ArrowDown': moveCursor(1); break;
      case 'k': case 'ArrowUp': moveCursor(-1); break;
      case 'h': case 'ArrowLeft': moveColumn(-1); break;
      case 'l': case 'ArrowRight': moveColumn(1); break;
      case 'g': moveCursor(-10000000); break;
      case 'G': moveCursor(10000000); break;
      case 'd': scrollByPage(0.5); break;
      case 'u': scrollByPage(shift ? -1 : -0.5); break;
      case ' ': e.preventDefault(); scrollByPage(shift ? -1 : 1); break;
      case 'Enter': openCursor(false); break;
      case 'o': openCursor(true); break;
      case 'Backspace': goBack(); break;
      case 'x': toggleExpand(cursorCell); break;
      case 'm': toggleMedia(cursorCell); break;
      case 'f': focusFilter(); break;
      case 's': toggleScan(); break;
      case 'p': togglePause(); break;
      case '?': toggleKeymap(); break;
      case 'Escape': clearCursorOrClose(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  async function init() {
    await loadCounters();
    await loadSettings();
    registerMessaging();
    document.addEventListener('keydown', onKeydown, true);
    // Activate as soon as the timeline exists; retry a few times for slow loads.
    activate();
  }

  // `document_idle` guarantees body exists, but be safe on early weird pages.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();