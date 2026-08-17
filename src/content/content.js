(() => {
  'use strict';
  // GridX content script.
  //
  // Read-only contract: we never move, delete or annotate X's own nodes. The
  // grid is a separate overlay built from copied text plus one real permalink
  // anchor per cell, so X keeps virtualizing its timeline exactly as it would
  // with no extension installed.
  //
  // Memory contract: the overlay holds at most `cap()` cells. Older cells are
  // dropped off the top as new posts arrive, so a long session cannot grow the
  // DOM without bound.

  const DEBUG = false;
  const log = (...a) => DEBUG && console.log('[gridx]', ...a);

  const CAP_MIN = 50;
  const CAP_MAX = 2000;
  const CAP_DEFAULT = 300;
  const TRIM_SLACK = 40;       // only trim once we are this far over the cap
  const SEEN_LIMIT = 5000;     // bounded dedupe memory
  const TICK_MS = 1000;
  const ADVANCE_COOLDOWN_MS = 900;

  let settings = {
    columnCount: 3, density: 'compact', fontScale: 1.0,
    showMedia: false, showAvatars: false, showMetrics: false,
    hideRetweets: false, hidePromoted: true, hideVerified: false,
    filterKeywords: [], filterHandles: [], extraCss: '',
    scanMode: false, paused: false,
    maxCells: CAP_DEFAULT, autoAdvance: true,
  };

  const STATS = { rendered: 0, filtered: 0, trimmed: 0, started: Date.now() };
  let active = false;
  let root = null;
  let extraStyle = null;
  let cursorPos = null;
  let cursorEl = null;

  const SELECTORS = {
    article: ['article[data-testid="tweet"]', 'article'],
    primaryColumn: ['[data-testid="primaryColumn"]', 'main section'],
    tweetText: ['div[data-testid="tweetText"]', '[data-testid="User-Name"] + div', 'div[lang]'],
    avatar: ['div[data-testid="UserAvatar-Container"] img', 'img[src*="profile_images"]'],
    name: ['div[data-testid="User-Name"] span', 'span[dir="ltr"]'],
    statusLink: ['a[href*="/status/"]'],
    photo: ['div[data-testid="tweetPhoto"] img'],
    group: ['div[role="group"]'],
    socialContext: ['[data-testid="socialContext"]'],
    verified: ['[data-testid="icon-verified"]'],
    promoted: ['[data-testid="placementTracking"]'],
  };

  function q(el, list) {
    for (const s of list) { const n = el.querySelector(s); if (n) return n; }
    return null;
  }

  function loadSettings() {
    chrome.storage.local.get('gridxSettings', (o) => {
      if (o && o.gridxSettings) settings = Object.assign(settings, o.gridxSettings);
      log('settings', settings);
      applySettings();
    });
  }

  function cap() {
    const n = Number(settings.maxCells) || CAP_DEFAULT;
    return Math.min(CAP_MAX, Math.max(CAP_MIN, n));
  }
  function cols() {
    return Number(settings.scanMode ? 8 : settings.columnCount) || 3;
  }

  // ---------- CSS application ----------
  function applySettings() {
    if (!root) return;
    root.style.setProperty('--gridx-cols', cols());
    root.style.setProperty('--gridx-font', settings.fontScale || 1);
    for (const d of ['compact', 'cozy', 'roomy']) {
      root.classList.toggle('gridx-d-' + d, (settings.density || 'compact') === d);
    }
    root.classList.toggle('gridx-scan', !!settings.scanMode);
    root.classList.toggle('gridx-paused', !!settings.paused);
    if (!extraStyle) {
      extraStyle = document.createElement('style');
      extraStyle.id = 'gridx-extra-css';
      document.head.appendChild(extraStyle);
    }
    extraStyle.textContent = settings.extraCss || '';
  }

  // ---------- Grid assembly ----------
  function ensureGrid() {
    if (active) return;
    if (!findPrimary()) { failSafe('GridX: timeline not found - reload the page or update selectors'); return; }
    active = true;
    root = document.createElement('div');
    root.id = 'gridx-root';
    document.body.appendChild(root);
    document.documentElement.classList.add('gridx-active');

    const css = document.createElement('style');
    css.id = 'gridx-chrome-hide';
    css.textContent = [
      '.gridx-active [data-testid="sidebarColumn"],',
      '.gridx-active header[role="banner"],',
      '.gridx-active [data-testid="app-bar-close"],',
      '.gridx-active nav[role="navigation"] { display:none !important; }',
    ].join('\n');
    document.head.appendChild(css);

    root.addEventListener('scroll', onGridScroll, { passive: true });
    applySettings();
    attachObserver();
    scanNow();
    log('grid active');
  }

  function findPrimary() {
    return q(document, SELECTORS.primaryColumn) || document.querySelector('main');
  }

  // ---------- bounded dedupe ----------
  const seenIds = new Set();
  const seenOrder = [];
  function markSeen(id) {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_LIMIT) seenIds.delete(seenOrder.shift());
    return true;
  }
  function forgetAll() { seenIds.clear(); seenOrder.length = 0; }

  function statusHref(article) {
    const l = q(article, SELECTORS.statusLink);
    if (!l) return null;
    // Prefer the canonical /handle/status/<id> permalink, not /photo/1 and friends.
    const raw = l.getAttribute('href') || '';
    const m = raw.match(/^(\/[^/]+\/status\/\d+)/);
    return m ? new URL(m[1], location.origin).href : (l.href || null);
  }

  function idFor(article, href) {
    if (href) return href;
    const t = (q(article, SELECTORS.tweetText) || {}).innerText || '';
    const n = (q(article, SELECTORS.name) || {}).innerText || '';
    const key = (n + '|' + t).slice(0, 120);
    return key.trim() ? 'txt:' + key : null;
  }

  function handleFrom(href) {
    if (!href) return '';
    const m = href.match(/\/\/[^/]+\/([^/]+)\/status\//);
    return m ? '@' + m[1] : '';
  }

  // ---------- scanning / hoisting ----------
  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued || !active || settings.paused) return;
    scanQueued = true;
    requestAnimationFrame(() => { scanQueued = false; scanNow(); });
  }

  function scanNow() {
    if (!active || !root || settings.paused) return 0;
    const pc = findPrimary();
    if (!pc) return 0;
    // X virtualizes: this list stays small (tens of nodes), never the whole feed.
    const arts = pc.querySelectorAll('article');
    let added = 0;
    for (const a of arts) if (hoist(a)) added++;
    if (added) {
      trim();
      STATS.rendered = root.childElementCount;
      log('added', added, 'total', STATS.rendered);
    }
    return added;
  }

  function hoist(article) {
    const href = statusHref(article);
    const id = idFor(article, href);
    if (!id || !markSeen(id)) return false;
    if (isFiltered(article, href)) { STATS.filtered++; return false; }
    const cell = makeCell(article, href);
    if (!cell) return false;
    root.appendChild(cell);
    return true;
  }

  // Cells are real anchors: click, middle-click, ctrl-click, "open in new tab"
  // and hover-preview of the URL all work natively, with no JS click handler.
  function makeCell(article, href) {
    const cell = document.createElement(href ? 'a' : 'div');
    cell.className = 'gridx-cell';
    if (href) {
      cell.href = href;
      cell.target = '_blank';
      cell.rel = 'noopener noreferrer';
    }

    const meta = document.createElement('div');
    meta.className = 'gridx-meta';
    if (settings.showAvatars) {
      const av = q(article, SELECTORS.avatar);
      if (av && av.src) {
        const img = document.createElement('img');
        img.className = 'gridx-av';
        img.src = av.src;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        meta.appendChild(img);
      }
    }
    const user = document.createElement('span');
    user.className = 'gridx-user';
    const nameEl = q(article, SELECTORS.name);
    user.textContent = (nameEl && nameEl.innerText.trim()) || handleFrom(href) || 'user';
    meta.appendChild(user);
    cell.appendChild(meta);

    const textEl = q(article, SELECTORS.tweetText);
    if (textEl) {
      const t = document.createElement('div');
      t.className = 'gridx-text';
      t.textContent = textEl.innerText;
      cell.appendChild(t);
    }

    const photoEl = q(article, SELECTORS.photo);
    if (photoEl) {
      if (settings.showMedia && photoEl.src) {
        const img = document.createElement('img');
        img.className = 'gridx-thumb';
        img.src = photoEl.src;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        cell.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'gridx-photo';
        ph.textContent = '[image]';
        cell.appendChild(ph);
      }
    }

    if (settings.showMetrics) {
      const group = q(article, SELECTORS.group);
      if (group) {
        const g = document.createElement('div');
        g.className = 'gridx-metrics';
        const r = group.querySelector('[data-testid="reply"]') ? '↩' : '';
        const rt = group.querySelector('[data-testid="retweet"]') ? '⟳' : '';
        const lk = group.querySelector('[data-testid="like"]') ? '♥' : '';
        const vw = group.querySelector('[data-testid="viewCount"]') ? '\u{1F441}' : '';
        g.textContent = [r, rt, lk, vw].filter(Boolean).join(' ');
        if (g.textContent) cell.appendChild(g);
      }
    }
    return cell;
  }

  function isFiltered(article, href) {
    if (settings.hidePromoted) {
      if (q(article, SELECTORS.promoted)) return true;
      const ctx = q(article, SELECTORS.socialContext);
      if (ctx && /\b(ad|promoted)\b/i.test(ctx.innerText || '')) return true;
    }
    if (settings.hideRetweets) {
      const ctx = q(article, SELECTORS.socialContext);
      if (ctx && /(repost|retweet)/i.test(ctx.innerText || '')) return true;
    }
    if (settings.hideVerified && q(article, SELECTORS.verified)) return true;

    const handles = settings.filterHandles || [];
    if (handles.length) {
      const h = handleFrom(href).toLowerCase();
      for (const raw of handles) {
        if (!raw) continue;
        const want = ('@' + String(raw).replace(/^@/, '')).toLowerCase();
        if (h && h === want) return true;
      }
    }

    const text = ((q(article, SELECTORS.tweetText) || {}).innerText || '').toLowerCase();
    for (const k of settings.filterKeywords || []) {
      if (k && text.includes(String(k).toLowerCase())) return true;
    }
    return false;
  }

  // Drop the oldest cells once we exceed the cap, preserving scroll position so
  // the grid does not jump under the reader.
  function trim() {
    const max = cap();
    const n = root.childElementCount;
    if (n <= max + TRIM_SLACK) return;
    const remove = n - max;
    const beforeH = root.scrollHeight;
    const beforeTop = root.scrollTop;
    for (let i = 0; i < remove; i++) {
      const first = root.firstElementChild;
      if (!first) break;
      if (first === cursorEl) cursorEl = null;
      first.remove();
    }
    const delta = beforeH - root.scrollHeight;
    if (delta > 0) root.scrollTop = Math.max(0, beforeTop - delta);
    if (cursorPos != null) cursorPos = Math.max(0, cursorPos - remove);
    STATS.trimmed += remove;
    log('trimmed', remove);
  }

  function resetGrid() {
    if (!root) return;
    root.textContent = '';
    forgetAll();
    cursorEl = null;
    cursorPos = null;
    root.scrollTop = 0;
    STATS.rendered = 0;
    attachObserver();
    scanNow();
    log('grid reset');
  }

  // ---------- observer, scoped to the timeline and batched ----------
  let observedTarget = null;
  const observer = new MutationObserver(() => scheduleScan());
  function attachObserver() {
    const target = findPrimary();
    if (!target || target === observedTarget) return;
    observer.disconnect();
    observer.observe(target, { childList: true, subtree: true });
    observedTarget = target;
    log('observing', target);
  }

  // The overlay owns the scroll, so X's own timeline never scrolls and never
  // fetches more posts. Nudge the underlying window when the reader reaches the
  // end of the grid: that is what keeps infinite scroll working behind a cap.
  let lastAdvance = 0;
  function onGridScroll() {
    if (!active || settings.paused || !settings.autoAdvance) return;
    const nearEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 600;
    if (!nearEnd) return;
    const now = Date.now();
    if (now - lastAdvance < ADVANCE_COOLDOWN_MS) return;
    lastAdvance = now;
    window.scrollBy(0, Math.round(window.innerHeight * 0.9));
  }

  // Safety net: re-attach after SPA route changes and catch any missed mutation.
  let lastHref = location.href;
  setInterval(() => {
    if (!active) return;
    if (location.href !== lastHref) { lastHref = location.href; resetGrid(); return; }
    if (!observedTarget || !observedTarget.isConnected) attachObserver();
    scheduleScan();
  }, TICK_MS);

  // ---------- cursor (O(1) per move, not O(cells)) ----------
  function cellAt(i) {
    return (i == null || i < 0) ? null : (root.children[i] || null);
  }
  function setCursor(i) {
    const n = root.childElementCount;
    if (!n) { cursorPos = null; return; }
    cursorPos = Math.min(n - 1, Math.max(0, i));
    const next = cellAt(cursorPos);
    if (next === cursorEl) return;
    if (cursorEl) cursorEl.classList.remove('gridx-cursor');
    cursorEl = next;
    if (cursorEl) {
      cursorEl.classList.add('gridx-cursor');
      cursorEl.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- Keyboard nav (vim-flavored) ----------
  function onKey(e) {
    if (!active || settings.paused) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement;
    const tag = ((ae && ae.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (ae && ae.isContentEditable)) return;
    const n = root.childElementCount;
    if (!n) return;
    const step = cols();
    const at = cursorPos == null ? 0 : cursorPos;
    const k = e.key;
    let handled = true;
    if (k === 'j' || k === 'ArrowDown') setCursor(at + step);
    else if (k === 'k' || k === 'ArrowUp') setCursor(at - step);
    else if (k === 'l' || k === 'ArrowRight') setCursor(at + 1);
    else if (k === 'h' || k === 'ArrowLeft') setCursor(at - 1);
    else if (k === 'g') setCursor(0);
    else if (k === 'G') setCursor(n - 1);
    else if (k === 's') toggleScanMode();
    else if (k === 'x') { const c = cellAt(cursorPos); if (c) c.classList.toggle('gridx-expanded'); }
    else if (k === 'p') { settings.paused = !settings.paused; persist(); applySettings(); }
    else if (k === 'f') focusFilter();
    else if (k === 'Enter' || k === 'o') { const c = cellAt(cursorPos); if (c && c.href) window.open(c.href, '_blank', 'noopener'); }
    else handled = false;
    if (handled) e.preventDefault();
  }

  function persist() { chrome.storage.local.set({ gridxSettings: settings }); }

  function toggleScanMode() {
    settings.scanMode = !settings.scanMode;
    persist();
    applySettings();
  }

  function focusFilter() {
    const k = window.prompt('GridX filter keywords (comma separated):', (settings.filterKeywords || []).join(','));
    if (k === null) return;
    settings.filterKeywords = k.split(',').map((s) => s.trim()).filter(Boolean);
    persist();
    resetGrid();
  }

  function failSafe(msg) {
    const o = document.createElement('div');
    o.id = 'gridx-failsafe';
    o.style.cssText = 'position:fixed;top:10px;left:10px;z-index:999999;background:#0f1116;color:#00e5ff;padding:12px;border:1px solid #00e5ff;font:13px sans-serif;max-width:420px;';
    o.textContent = msg;
    document.body.appendChild(o);
  }

  // ---------- messaging ----------
  function contentKey() {
    return JSON.stringify([
      settings.filterKeywords, settings.filterHandles,
      settings.hidePromoted, settings.hideRetweets, settings.hideVerified,
      settings.showAvatars, settings.showMedia, settings.showMetrics,
    ]);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'gridx:update') {
      const before = contentKey();
      settings = Object.assign(settings, msg.settings || {});
      persist();
      applySettings();
      // Anything that changes what a cell contains needs a rebuild, not a restyle.
      if (contentKey() !== before) resetGrid();
      sendResponse({ ok: true, rendered: STATS.rendered, filtered: STATS.filtered, trimmed: STATS.trimmed });
    }
    return true;
  });

  // ---------- boot ----------
  loadSettings();
  document.addEventListener('keydown', onKey);
  setTimeout(ensureGrid, 1200);
})();
