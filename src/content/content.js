/* ============================================================================
 * GridX content script - "CSS re-flow" architecture, multi-site
 * ----------------------------------------------------------------------------
 * v0.3: the re-flow engine is site-agnostic and driven by the SITES adapter
 * table below. X and Reddit are supported; adding a site is one table entry.
 * Per-site facts that bit us in testing and are now encoded in the adapters:
 *   - Reddit scrolls the DOCUMENT, X scrolls the feed container. We only take
 *     over scrolling where the feed is the scroller; locking overflow on Reddit
 *     freezes the page and strands its infinite-scroll sentinel.
 *   - Reddit interleaves <hr> separators between entries, so they are excluded
 *     from feed detection and hidden rather than each occupying a grid cell.
 *   - Hiding a sidebar is not enough to reclaim its width: its grid TRACK
 *     survives, so the feed container is told to span every track.
 *
 * v0.2: pivot from "DOM hoisting" (moving <article> nodes) to re-flowing the
 * site's own timeline IN PLACE via CSS. This is a direct response to two real-world
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
  const CLASS_UNVIRT = 'gx-unvirtualized';
  const CLASS_LOCK = 'gx-lock-scroll';
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

  /* ------------------------------------------------------------------ *
   * Site adapters.
   *
   * Everything site-specific lives here: which element is a post, where its
   * permalink comes from, and how to recognise an ad. The rest of GridX is
   * site-agnostic and drives whichever adapter matches the current hostname.
   *
   * Reddit facts these are built on (verified against live www.reddit.com,
   * not guessed): the feed is <shreddit-feed>; each post is a <shreddit-post>
   * wrapped in an <article>; ads are <shreddit-ad-post> siblings that are NOT
   * wrapped; <hr> separators sit between every entry; and the document, not
   * the feed, owns the scroll.
   * ------------------------------------------------------------------ */
  const SITES = [
    {
      id: 'x',
      label: 'X',
      hosts: /(^|\.)(x|twitter)\.com$/i,
      post: 'article[data-testid="tweet"], article',
      // Containers we must never turn into a grid.
      notHost: [
        '[data-testid="primaryColumn"]', '[data-testid="sidebarColumn"]',
        '[data-testid="TopBar"]', '[data-testid="topBar"]',
        'header', 'nav', 'main', 'body', 'html',
      ],
      // Non-post filler among the host's children (excluded from host scoring
      // and hidden in the grid so it never occupies a cell).
      filler: '',
      // X's timeline container is itself the scroller.
      ownScroller: true,
      // x.com caps the timeline at 600px on an obfuscated intermediate wrapper
      // and centres MAIN's single flex child. Hiding the rails does not lift
      // either, so the whole ancestor chain has to be widened by hand.
      widenChain: true,
      permalink: (el) => { const l = el.querySelector('a[href*="/status/"]'); return l ? l.href : ''; },
      sponsored: (el) => !!el.querySelector('a[aria-label*="sponsored"]'),
      repost: (el) => /reposted/i.test(el.textContent || ''),
      verified: (el) => !!el.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified"]'),
    },
    {
      id: 'reddit',
      label: 'Reddit',
      hosts: /(^|\.)reddit\.com$/i,
      // shreddit (current), plus old.reddit.com's markup.
      post: 'shreddit-post, shreddit-ad-post, .thing.link',
      notHost: [
        'shreddit-app', '#main-content', '.subgrid-container', '.grid-container',
        'header', 'nav', 'main', 'body', 'html',
      ],
      // new.reddit separates entries with <hr>; old.reddit follows every
      // .thing with an empty <div class="clearleft">. Measured on live
      // old.reddit.com: 25 posts and 25 clearleft spacers, so a THIRD of the
      // grid was blank cells and the reading order zigzagged.
      filler: 'hr, .clearleft',
      // Reddit scrolls the document; the feed is not a scroller.
      ownScroller: false,
      // Reddit's own rails are hidden in CSS; no ancestor cap to lift.
      widenChain: false,
      permalink: (el) => {
        const a = el.getAttribute && (el.getAttribute('permalink') || el.getAttribute('data-permalink'));
        if (a) { try { return new URL(a, location.origin).href; } catch (e) {} }
        const l = el.querySelector('a[href*="/comments/"]');
        return l ? l.href : '';
      },
      sponsored: (el) => el.tagName.toLowerCase() === 'shreddit-ad-post' ||
        (el.hasAttribute && (el.hasAttribute('promoted') || el.getAttribute('data-promoted') === 'true')),
      // Reddit has no repost concept in the X sense; crossposts are ordinary posts.
      repost: () => false,
      verified: () => false,
    },
  ];

  function detectSite() {
    const byHost = SITES.find((s) => s.hosts.test(location.hostname));
    if (byHost) return byHost;
    // Local fixtures declare which site's markup they emulate:
    //   <html data-gridx-site="reddit">
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      const want = (document.documentElement.getAttribute('data-gridx-site') || 'x').toLowerCase();
      return SITES.find((s) => s.id === want) || SITES[0];
    }
    return null;
  }
  const SITE = detectSite();

  const ARTICLE = SITE ? SITE.post : 'article';
  const FILLER = SITE ? SITE.filler : '';

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
    for (const s of (SITE ? SITE.notHost : [])) { try { if (el.matches(s)) return true; } catch (e) {} }
    return false;
  }
  // The element that actually sits in the grid: walk up from the post to the
  // host's direct child. On X that is [data-testid="cellInnerDiv"], on Reddit
  // the <article> wrapping <shreddit-post>. Hiding or measuring the inner post
  // instead would leave an empty cell behind.
  function cellOf(post) {
    if (!host || !isEl(post)) return post;
    let el = post;
    while (el.parentElement && el.parentElement !== host) el = el.parentElement;
    return el.parentElement === host ? el : post;
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
          <tr><td>Site</td><td class="gx-km-site">-</td></tr>
        </table>
        <p class="gx-km-note">Keys are ignored while typing.</p>
      </div>
      <div id="gridx-fatal" hidden>
        <h1>GridX: feed not found</h1>
        <p>GridX could not locate the feed container on this page.</p>
        <p>This usually means the site shipped a markup change, or you are not on a feed.</p>
        <button id="gridx-fatal-close">Close GridX</button>
      </div>
      <div id="gridx-statusbar"><span class="gx-hints"></span><span class="gx-stats"></span></div>
    `;
    document.body.appendChild(root);

    filterInput = root.querySelector('#gridx-filter-input');
    hintsEl = root.querySelector('.gx-hints');
    statsEl = root.querySelector('.gx-stats');
    keymapEl = root.querySelector('#gridx-keymap');
    const siteCell = root.querySelector('.gx-km-site');
    if (siteCell) siteCell.textContent = SITE ? SITE.label : 'unsupported';
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
    // Separators (Reddit puts an <hr> between every entry) are not content and
    // must not dilute the ratio below: shreddit-feed is 28 posts among 70
    // children, which would otherwise fail a naive 50% test.
    const kids = Array.from(el.children).filter((k) => !(FILLER && k.matches && k.matches(FILLER)));
    if (kids.length < 3) return false;
    let withArticle = 0;
    for (const k of kids) {
      // A child may be the post itself (fixture, Reddit ads) or a wrapper that
      // CONTAINS one (X's [data-testid="cellInnerDiv"], Reddit's <article>).
      if (k.matches && k.matches(ARTICLE)) withArticle++;
      else if (k.querySelector && k.querySelector(ARTICLE)) withArticle++;
    }
    return withArticle >= 2 && withArticle >= kids.length * 0.5;
  }

  // Which element actually owns the scroll? Guessing this per-site was wrong:
  // x.com scrolls the DOCUMENT (its timeline is a tall container with a virtual
  // height), so locking body overflow froze the page outright. Measured once at
  // activation, BEFORE we touch any styles, because applyGrid would otherwise
  // make the host look like a scroller and the answer would always be yes.
  let hostWasScroller = false;

  // How much scroll range does the PAGE actually have? Asking documentElement
  // alone is wrong: on live x.com <html> is exactly viewport-height with no
  // range at all, and <body> is the element that scrolls (measured: html
  // scrollHeight 678 === clientHeight, body scrollHeight 1540 / clientHeight
  // 678). A guard that read only documentElement therefore concluded "this
  // page cannot scroll" about a page that scrolls perfectly well.
  function pageScrollRange() {
    let best = 0;
    const els = [document.documentElement, document.body, host];
    for (const el of els) {
      if (!el) continue;
      try { best = Math.max(best, el.scrollHeight - el.clientHeight); } catch (e) {}
    }
    return best;
  }

  // x.com caps its timeline column at 600px on an intermediate wrapper whose
  // class is obfuscated, and MAIN centres its single child instead of
  // stretching it. Both survive hiding the rails, so on a 1280px viewport the
  // grid rendered 196px columns: post text wrapped after three words, avatars
  // collapsed to grey squares and the metric row overlapped itself. Tagging
  // our own ancestor chain lets the stylesheet lift the caps in that path only,
  // rather than firing !important width rules at the whole document.
  function tagWidenChain() {
    if (!host || !SITE || !SITE.widenChain) return;
    let el = host;
    let hops = 0;
    while (el && el !== document.body && hops++ < 12) {
      el.setAttribute('data-gx-widen', '1');
      if (el.tagName === 'MAIN') break;
      el = el.parentElement;
    }
  }

  function untagWidenChain() {
    document.querySelectorAll('[data-gx-widen]')
      .forEach((el) => el.removeAttribute('data-gx-widen'));
  }

  function detectScroller(el) {
    if (!el) return false;
    try {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return false;
      return el.scrollHeight > el.clientHeight + 20;
    } catch (e) { return false; }
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
    // Only take over scrolling on sites whose feed container is the scroller.
    // Reddit scrolls the document: turning shreddit-feed into its own scroller
    // strands Reddit's infinite-scroll sentinel and kills pagination, so we
    // leave the page's native scroll model alone there.
    if (hostWasScroller) {
      // The feed container really is the scroller: keep it that way.
      setInline('overflowY', 'auto');
      setInline('overflowX', 'hidden');
      setInline('overscrollBehavior', 'contain');
      setInline('scrollBehavior', 'auto');
    } else {
      // The document owns the scroll. Touch nothing that could freeze it.
      setInline('overflowX', 'hidden');
    }

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

    // A virtualized feed positions its cells absolutely and places them with a
    // transform (X does exactly this). Absolutely positioned children are OUT
    // OF FLOW, so display:grid on the container has nothing to lay out and
    // every post keeps its original full-width position: the grid appears to
    // apply and visibly does nothing. Detect that and put the cells back in
    // flow so the grid can actually place them.
    if (detectOutOfFlow()) setTimeout(verifyUnvirtualize, 400);
    applyScanClass();
  }

  // Putting virtualized cells back in flow makes the grid work, but the
  // container's height was what created the page's scroll range. On a feed that
  // pages by scroll offset, removing it can leave the page unable to scroll at
  // all - which is strictly worse than no grid. Verify, and back out if so.
  let unvirtBlocked = false;
  function revertUnvirtualize(reason) {
    document.documentElement.classList.remove(CLASS_UNVIRT);
    unvirtBlocked = true;
    setStatus('GridX: this feed is virtualized, keeping the site layout', 6000);
    log('unvirtualize reverted:', reason);
  }

  function verifyUnvirtualize() {
    if (!active || !host) return;
    if (!document.documentElement.classList.contains(CLASS_UNVIRT)) return;
    // The old threshold of 8 posts was unreachable in the only case that
    // matters: killing the scroll range is exactly what stops more posts
    // arriving, so the count stays low and the guard never fired. Three posts
    // is enough to know a feed rendered.
    const canScroll = pageScrollRange() > 200;
    const hasMore = articles().length >= 3;
    if (!canScroll && hasMore) {
      revertUnvirtualize('it removed the page scroll range');
      return;
    }
    startPaginationWatch();
  }

  // Losing the scroll range is the loud failure. The quiet one is worse: the
  // page still scrolls, but the site's virtualizer decides what to mount from
  // its own model of where each cell sits, and putting the cells back in flow
  // invalidates that model. Measured on live x.com: scrolling 4000px left the
  // mounted count pinned at 8 and the unique-post count at 7, with 7000px of
  // blank container below the last post. Watch for the reader running out of
  // feed and back out to the site's own layout when they do.
  let unvirtWatch = null;
  function startPaginationWatch() {
    stopPaginationWatch();
    if (!host) return;
    const baseline = articles().length;
    let strikes = 0;
    unvirtWatch = setInterval(() => {
      if (!active || !host || !document.documentElement.classList.contains(CLASS_UNVIRT)) {
        stopPaginationWatch();
        return;
      }
      const last = host.children[host.children.length - 1];
      if (!last) return;
      let bottom = 0;
      try { bottom = last.getBoundingClientRect().bottom; } catch (e) { return; }
      // Scrolled clean past every mounted post, and nothing new arrived.
      if (bottom < 0 && articles().length <= baseline) strikes++;
      else strikes = 0;
      if (strikes >= 3) {
        revertUnvirtualize('the feed stopped mounting posts in grid layout');
        stopPaginationWatch();
      }
    }, 1000);
  }

  function stopPaginationWatch() {
    if (unvirtWatch) { clearInterval(unvirtWatch); unvirtWatch = null; }
  }

  function detectOutOfFlow() {
    if (!host) return false;
    const kids = Array.from(host.children).slice(0, 12)
      .filter((k) => !(FILLER && k.matches && k.matches(FILLER)));
    if (!kids.length) return false;
    let abs = 0;
    for (const k of kids) {
      let pos = '';
      try { pos = getComputedStyle(k).position; } catch (e) { continue; }
      if (pos === 'absolute' || pos === 'fixed') abs++;
    }
    const outOfFlow = abs >= Math.max(2, kids.length * 0.5) && !unvirtBlocked;
    document.documentElement.classList.toggle(CLASS_UNVIRT, outOfFlow);
    if (outOfFlow) log('feed is virtualized/out-of-flow; cells put back in flow');
    return outOfFlow;
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
      const url = SITE ? SITE.permalink(a) : '';
      if (url) a.dataset.gxUrl = url;
    }
  }

  function articles() {
    return host ? Array.from(host.querySelectorAll(ARTICLE)) : [];
  }

  function isSponsor(a) { try { return !!SITE.sponsored(a); } catch (e) { return false; } }
  function isRetweeted(a) { try { return !!SITE.repost(a); } catch (e) { return false; } }
  function isVerified(a) { try { return !!SITE.verified(a); } catch (e) { return false; } }

  function termHides(text, terms) {
    for (const raw of terms || []) {
      const t = (raw || '').trim().toLowerCase();
      if (!t) continue;
      if (t[0] === '-') { const rest = t.slice(1); if (rest && !text.includes(rest)) return true; }
      else if (text.includes(t)) return true;
    }
    return false;
  }

  // Posts we have already tagged, and their cached lowercase text. Re-deriving
  // either on every mutation is what made the grid crawl: the old version read
  // innerText (a forced synchronous layout) for every post in the feed, on every
  // mutation, even with no filter set. Measured at 27.7ms per call.
  const seenPosts = new WeakSet();
  const textCache = new WeakMap();
  let hiddenNow = 0;
  let lastFilterKey = null;

  function filterKey() {
    return JSON.stringify([
      settings.filterKeywords, settings.filterHandles,
      !!settings.hidePromoted, !!settings.hideRetweets, !!settings.hideVerified,
    ]);
  }
  function filtersActive() {
    return !!(
      (settings.filterKeywords && settings.filterKeywords.length) ||
      (settings.filterHandles && settings.filterHandles.length) ||
      settings.hidePromoted || settings.hideRetweets || settings.hideVerified
    );
  }
  // textContent, never innerText: innerText forces layout, textContent does not.
  function textOf(a) {
    let t = textCache.get(a);
    if (t === undefined) { t = (a.textContent || '').toLowerCase(); textCache.set(a, t); }
    return t;
  }
  function setHidden(a, hide) {
    if (a.classList.contains('gx-hidden') !== hide) invalidateList();
    a.classList.toggle('gx-hidden', hide);
    // Hiding only the inner post would leave its wrapper occupying a cell.
    const cell = cellOf(a);
    if (cell !== a) cell.classList.toggle('gx-hidden', hide);
  }

  function recomputeFilters() {
    if (!host) return;
    const all = articles();               // one query, not two
    if (!listCache || listCache.length !== all.length) invalidateList();
    stats.postsRendered = all.length;

    const key = filterKey();
    const filtersChanged = key !== lastFilterKey;
    lastFilterKey = key;

    if (!filtersActive()) {
      // Fast path, and the common case: nothing to hide. Tag only posts we have
      // not seen, and sweep old hides away only if there are any.
      for (const a of all) if (!seenPosts.has(a)) { seenPosts.add(a); markArticle(a); }
      if (hiddenNow || filtersChanged) {
        for (const a of all) setHidden(a, false);
        hiddenNow = 0;
      }
      stats.postsFiltered = 0;
      updateStatsReadout();
      return;
    }

    let hidden = 0;
    for (const a of all) {
      const isNew = !seenPosts.has(a);
      if (isNew) { seenPosts.add(a); markArticle(a); }
      // A post's verdict only changes when it is new or the filters changed.
      if (!isNew && !filtersChanged) {
        if (a.classList.contains('gx-hidden')) hidden++;
        continue;
      }
      const text = textOf(a);
      const hide =
        termHides(text, settings.filterKeywords) ||
        termHides(text, settings.filterHandles) ||
        (settings.hidePromoted && isSponsor(a)) ||
        (settings.hideRetweets && isRetweeted(a)) ||
        (settings.hideVerified && isVerified(a));
      setHidden(a, hide);
      if (hide) hidden++;
    }
    hiddenNow = hidden;
    stats.postsFiltered = hidden;
    updateStatsReadout();
  }

  /* ------------------------------------------------------------------ *
   * Observer: react to X appending/removing articles without moving them.
   * We only re-tag + re-filter. X's own virtualization does the rest.
   * ------------------------------------------------------------------ */
  // Only element additions/removals that actually involve a POST matter. Live
  // feeds churn constantly - ticking timestamps, updating counters - and those
  // arrive as text-node mutations. Reacting to them re-ran the whole filter pass
  // several times a second for no benefit.
  function touchesPost(nodes) {
    for (const nd of nodes) {
      if (nd.nodeType !== 1) continue;
      if (nd.matches && nd.matches(ARTICLE)) return true;
      if (nd.querySelector && nd.querySelector(ARTICLE)) return true;
    }
    return false;
  }

  let scanQueued = false;
  function wireObserver() {
    if (!host) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      if (paused || scanQueued) return;
      let relevant = false;
      for (const r of records) {
        if (r.type !== 'childList') continue;
        if (touchesPost(r.addedNodes) || touchesPost(r.removedNodes)) { relevant = true; break; }
      }
      if (!relevant) return;
      // Coalesce a burst of mutations into a single pass per frame.
      scanQueued = true;
      requestAnimationFrame(() => {
        scanQueued = false;
        if (!active || paused) return;
        // Only re-resolve the container if the one we hold actually went away;
        // findHost() walks the DOM and is far too costly to run per mutation.
        if (!host || !host.isConnected) {
          const now = findHost();
          if (now && now !== host) {
            detachObserver(); host = now; savedStyles = {};
            ensureOverlay(); applyGrid(); wireObserver();
          }
        }
        recomputeFilters();
      });
    });
    observer.observe(host, { childList: true, subtree: true });
  }
  function detachObserver() { if (observer) { observer.disconnect(); observer = null; } }

  /* ------------------------------------------------------------------ *
   * Health watchdog.
   *
   * The MutationObserver is attached to the feed container. If the site
   * REPLACES that container - which every SPA navigation on X does - the node
   * we hold detaches, and a detached node emits no mutations ever again. The
   * observer can therefore never notice its own death, and the grid silently
   * stops working until a reload. This poll is the only thing that can catch
   * that, so it stays cheap: an isConnected check and a computed-style read.
   * ------------------------------------------------------------------ */
  let healthTimer = null;
  let lastHref = location.href;

  function startHealth() {
    stopHealth();
    healthTimer = setInterval(() => {
      if (!active || paused) return;

      if (location.href !== lastHref) {
        lastHref = location.href;
        if (cursorArticle) { cursorArticle.classList.remove('gx-cursor'); cursorArticle = null; }
        invalidateList();
      }

      // Feed container replaced or removed: re-resolve and re-apply.
      if (!host || !host.isConnected) {
        const next = findHost();
        if (next) {
          detachObserver();
          host = next;
          savedStyles = {};
          applyGrid();
          wireObserver();
          recomputeFilters();
          log('reattached to a new feed container');
        }
        return;
      }

      // Still our container, but the site re-rendered and clobbered the grid.
      let disp = '';
      try { disp = getComputedStyle(host).display; } catch (e) { return; }
      if (disp !== 'grid') { applyGrid(); recomputeFilters(); log('grid reapplied'); }
    }, 1500);
  }
  function stopHealth() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }

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
    const url = art.dataset.gxUrl || (SITE ? SITE.permalink(art) : '');
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
    document.documentElement.classList.add('gridx-site-' + SITE.id);
    savedStyles = {};
    tagWidenChain();
    hostWasScroller = detectScroller(host);
    document.documentElement.classList.toggle(CLASS_LOCK, hostWasScroller);
    log('scroll owner:', hostWasScroller ? 'feed container' : 'document');
    applyGrid();
    recomputeFilters();
    wireObserver();
    startHealth();
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    startStats();
    setStatus('GridX active on ' + (SITE ? SITE.label : 'this site'));
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
    stopHealth();
    stopStats();
    stopPaginationWatch();
    untagWidenChain();
    restoreHost();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.documentElement.classList.remove(CLASS_ACTIVE, CLASS_SCAN);
    for (const s of SITES) document.documentElement.classList.remove('gridx-site-' + s.id);
    document.documentElement.classList.remove(CLASS_UNVIRT, CLASS_LOCK);
    unvirtBlocked = false;
    hostWasScroller = false;
    replantAll();
    active = false;
    cursorArticle = null;
    invalidateList();
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
    let ticks = 0;
    statTimer = setInterval(() => {
      if (!paused) stats.gridActiveMs += 1000;
      updateStatsReadout();
      // Persisting counters every second is a storage write per second for no
      // reason; every 15s is plenty for a stats readout.
      if (++ticks % 15 === 0) persistCounters();
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

  // Cached because every cursor move used to rebuild it: a full querySelectorAll
  // plus a filter across the whole feed, per keypress. Invalidated whenever the
  // post set or the hidden set changes.
  let listCache = null;
  function invalidateList() { listCache = null; }
  function list() {
    if (listCache) return listCache;
    listCache = (host ? Array.from(host.querySelectorAll(ARTICLE)) : [])
      .filter((a) => !a.classList.contains('gx-hidden'));
    return listCache;
  }
  function idx(a, l) { return (l || list()).indexOf(a); }
  function fullyVisible(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top >= 0 && r.bottom <= vh;
  }
  function focus(a) {
    if (!a) return;
    if (cursorArticle) cursorArticle.classList.remove('gx-cursor');
    cursorArticle = a; a.classList.add('gx-cursor');
    // scrollIntoView forces layout; skip it when the post is already on screen.
    if (!fullyVisible(a)) a.scrollIntoView({ block: 'nearest' });
  }
  function move(delta) {
    const l = list(); if (!l.length) return;
    const i = idx(cursorArticle, l);
    focus(l[i < 0 ? 0 : Math.max(0, Math.min(l.length - 1, i + delta))]);
  }
  function scrollBy(f) {
    if (host && hostWasScroller) { host.scrollTop += f * (host.clientHeight || 900); return; }
    window.scrollBy(0, f * (window.innerHeight || 900));
  }
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
    // No adapter for this host: do nothing at all, leave the page untouched.
    if (!SITE) return;
    await loadCounters();
    await loadSettings();
    registerMessaging();
    activate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();