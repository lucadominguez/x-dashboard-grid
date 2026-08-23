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
  // Stamped on <html> so it is possible to tell, from the page itself, WHICH
  // build is running. Chrome serves an unpacked extension's content script
  // from its own cache, so an edit on disk is not necessarily the code in the
  // tab - a whole debugging session was spent measuring the old build.
  const BUILD = '0.3.0+mirror5';
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
      // A legibility floor, not a fit one: a narrow column now SCALES the
      // whole post (see applyMirrorColumns), so the question is no longer
      // whether a post fits but whether it can still be read. 150px at the
      // 0.6 floor is a post rendered at 250px and shown at 150.
      minColumn: 150,
      // A grid of one post is not a grid. /status/ is the permalink view and
      // /i/ covers the photo and modal routes X opens on top of it.
      feedRoute: (p) => !/\/status\/\d+/.test(p) && !/^\/i\//.test(p),
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
      // An absolute floor. 250 was a comfort figure and it silently capped a
      // request for eight columns at four, which is not a call GridX gets to
      // make: asking for eight columns is asking for dense, and the scaling
      // and wrapping rules below are what keep dense legible.
      minColumn: 120,
      // /comments/ is Reddit's single-post view on both new and old.
      feedRoute: (p) => !/\/comments\//.test(p),
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

  try { document.documentElement.dataset.gridxBuild = BUILD; } catch (e) {}
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

  // How much scroll range does the PAGE actually have? Ask every candidate,
  // because which element owns the scroll is not knowable per-site: x.com
  // scrolls <html>, Reddit scrolls the document, and a feed container can own
  // it outright. GridX once recorded "x.com scrolls <body>" as a site fact and
  // built guards around it; it was self-inflicted - the stylesheet clipped
  // body's overflow-x, which under the CSS spec forces overflow-y to auto and
  // makes body a scroller. Reading all three costs nothing and cannot be
  // wrong-footed that way again.
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
  // How many columns will actually READ at this width? Asking for eight columns
  // in a 1280px window gives 151px cells, and at that width old.reddit spends
  // 40px on the vote gutter and wraps titles two words to a line - a denser
  // grid that conveys less, which is the opposite of the point. Honour the
  // request only as far as the window can carry it.
  function fittedColumns(requested) {
    const min = (SITE && SITE.minColumn) || 200;
    let width = 0;
    try { width = host.getBoundingClientRect().width; } catch (e) {}
    if (!width) return requested;
    const gap = (settings.bleed ? 0 : 6) * densityScale();
    const fits = Math.floor((width + gap) / (min + gap));
    return Math.max(1, Math.min(requested, fits));
  }

  // Density / font-scale as CSS vars cascading into articles, plus the
  // switches the stylesheet reads off <html>. Everything here is layout-model
  // agnostic, which is why both the in-place grid and the mirror can call it.
  function applyDisplayFlags() {
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
  }

  function applyGrid() {
    if (!host) return;
    // Re-checked here as well as at activation: the site may not have reserved
    // its virtual height yet when we first looked, and applyGrid runs again
    // whenever the health watchdog re-attaches to a rebuilt feed.
    if (isTransformVirtualized(host)) {
      restoreHost();
      untagWidenChain();
      // The reader's display settings are applied on BOTH paths. They used to
      // live below this return, so on x.com - the only site that reaches mirror
      // mode - density, font scale and the avatar/media/metric switches were
      // all inert: the grid rendered full-size posts with their images even
      // though showMedia defaults to false. Four untouched posts side by side
      // is not a high-density dashboard.
      applyDisplayFlags();
      applyScanClass();
      // Re-entry must not rebuild. applyGrid runs again on every settings
      // change and from the health watchdog, and startMirror() drops every
      // clone collected so far - so the grid would silently reset to whatever
      // the site happens to have mounted at that moment.
      if (mirror) { applyMirrorColumns(); scheduleMirror(true); }
      else startMirror();
      return;
    }
    const requested = clampInt(settings.columnCount, 1, 8);
    const cols = fittedColumns(requested);
    if (cols !== requested) {
      setStatus('GridX: ' + requested + ' columns will not read at this width, using ' + cols, 5000);
    }
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
    // Row gap MUST be zero while the height packing is on. The packing spans a
    // 4px track per cell, and a row gap is inserted between EVERY track, so a
    // 107px post spanning 29 tracks occupied 29*4 + 28*6 = 284px. That, not the
    // packing itself, was the source of the holes down every column. The gap is
    // instead baked into each cell's span.
    cellGap = gap;
    setInline('rowGap', '0px');
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

    applyDisplayFlags();

    // A virtualized feed positions its cells absolutely and places them with a
    // transform (X does exactly this). Absolutely positioned children are OUT
    // OF FLOW, so display:grid on the container has nothing to lay out and
    // every post keeps its original full-width position: the grid appears to
    // apply and visibly does nothing. Detect that and put the cells back in
    // flow so the grid can actually place them.
    if (detectOutOfFlow()) setTimeout(verifyUnvirtualize, 400);
    // Tiny implicit rows are what let a cell span exactly its own height.
    setInline('gridAutoRows', ROW_UNIT + 'px');
    scheduleMasonry();
    stats.effectiveColumns = measureColumns();
    applyScanClass();
  }

  // Putting virtualized cells back in flow makes the grid work, but the
  // container's height was what created the page's scroll range. On a feed that
  // pages by scroll offset, removing it can leave the page unable to scroll at
  // all - which is strictly worse than no grid. Verify, and back out if so.
  let unvirtBlocked = false;
  // Once a feed has proved it cannot be gridded, stay off it. Without this the
  // health watchdog and the route watcher both cheerfully re-activate and the
  // whole cycle runs again on every navigation.
  let virtualizedGiveUp = false;

  function revertUnvirtualize(reason) {
    document.documentElement.classList.remove(CLASS_UNVIRT);
    unvirtBlocked = true;
    log('unvirtualize reverted:', reason);
    // Backing out of the unvirtualize alone left the worst of both worlds: the
    // cells go back to being absolutely positioned so the grid does nothing,
    // but the feed KEEPS the width we reclaimed for it - which on x.com means
    // a single column of posts stretched across the whole 1248px window,
    // measurably worse to read than the site's own centred column. If we
    // cannot grid the feed we have no business restyling it either, so stand
    // all the way down and say so plainly.
    virtualizedGiveUp = true;
    const label = SITE ? SITE.label : 'this site';
    deactivate();
    showFatal('GridX cannot grid ' + label + "'s timeline: the site renders it "
      + 'virtualized, and its own loader stops feeding posts when the grid takes '
      + 'over placement. Leaving the site layout untouched.');
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

  // Recognise a transform-virtualizer BEFORE touching the page.
  //
  // The watchdog below can only fire once the reader has scrolled past every
  // mounted post, so it cures the problem after they have already been shown a
  // broken grid: five columns of one-word-per-line text over five posts that
  // never grow. The signature is unmistakable up front, and both halves are
  // needed - absolutely positioned children placed by transform, AND a large
  // inline min-height on the container, which is the virtual scroll height the
  // site reserves for posts it has not mounted. Reddit has neither; x.com has
  // both (measured: min-height 11270px over four mounted cells).
  function isTransformVirtualized(el) {
    if (!el) return false;
    let inlineMinH = 0;
    try { inlineMinH = parseFloat(el.style.minHeight) || 0; } catch (e) { return false; }
    if (inlineMinH < 1500) return false;
    let abs = 0, n = 0;
    for (const k of el.children) {
      if (!isEl(k) || n >= 8) break;
      n++;
      try {
        const d = getComputedStyle(k);
        if ((d.position === 'absolute' || d.position === 'fixed') && d.transform !== 'none') abs++;
      } catch (e) {}
    }
    return n >= 2 && abs >= Math.max(2, n * 0.5);
  }

  /* ------------------------------------------------------------------ *
   * Mirror mode: the grid for feeds that place their own posts.
   *
   * x.com cannot be gridded in place, and this was established by measurement
   * rather than argument. Its timeline container carries an inline min-height
   * equal to the virtual scroll height, and every cell is absolutely
   * positioned by a transform. Move those cells by ANY means - put them back
   * in flow, or collapse the reserved height so real content fills the scroll
   * range - and the virtualizer stops feeding: measured 8 posts, frozen,
   * across 4000px of scrolling in both directions.
   *
   * The second measurement is what made a grid possible anyway. On an
   * UNTOUCHED x.com the mounted count also sits at 8-9, because X unmounts
   * posts as they leave the viewport; that is its normal steady state, not a
   * symptom. Unique posts keep arriving as the reader scrolls. So the feed is
   * not broken - it just never holds more than a screenful at once.
   *
   * Mirror mode therefore touches X's timeline not at all. It watches posts
   * mount, keeps a clone of each one, and paints the accumulated set into its
   * own grid layered over the column. The overlay takes no pointer events, so
   * the wheel still reaches X underneath and its virtualizer keeps working on
   * the reader's own scrolling - which matters, because a content script
   * cannot drive it: programmatic scrolling moved the page 4800px and mounted
   * nothing, since X responds to trusted input only.
   * ------------------------------------------------------------------ */
  const MIRROR_CAP = 400;   // clones retained before the oldest are dropped
  // The width a post wants. Narrower than this it is scaled, not refused.
  const COMFORT_COLUMN = 260;
  let mirror = null;

  function startMirror() {
    stopMirror();
    const main = document.querySelector('main') || document.body;
    const root = document.createElement('div');
    root.id = 'gridx-mirror';
    const inner = document.createElement('div');
    inner.id = 'gridx-mirror-inner';
    // Everything the stylesheet knows about a grid cell - wrapping, density,
    // the avatar/media/metric switches, the ellipsised nowrap metadata - is
    // written against `.gx-stream`. The mirror IS the grid here, so it carries
    // the same class rather than growing a parallel copy of all of it. Nothing
    // else answers to that class in mirror mode: restoreHost() takes it off
    // the site's own container on the way in.
    inner.classList.add('gx-stream');
    root.appendChild(inner);
    document.body.appendChild(root);
    mirror = { root: root, inner: inner, seen: new Map(), order: [], main: main };
    mirror.pinned = pinnedBottom();
    positionMirror();
    applyMirrorColumns();
    document.documentElement.classList.add('gridx-mirror-on');
    captureIntoMirror();
    syncMirror(true);
    if (typeof ResizeObserver !== 'undefined') {
      // The observer already carries the new size, so take the number from it
      // rather than measuring again, and ignore sub-pixel noise: X rewrites a
      // post's relative timestamp and hover state constantly, and every one of
      // those used to cost a full re-measure of the whole collection.
      mirror.sizes = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const box = e.borderBoxSize && e.borderBoxSize[0];
          const h = Math.round(box ? box.blockSize : (e.contentRect ? e.contentRect.height : 0));
          if (!h) continue;
          if (Math.abs((rawHeights.get(e.target) || 0) - h) < 2) continue;
          rawHeights.set(e.target, h);
          dirtyCells.add(e.target);
          changed = true;
        }
        if (changed) scheduleMirror(true);
      });
    }
    // A mutation means "look for new posts", not "re-place every post": the
    // repack now happens only when capture actually adds or refreshes one.
    mirror.obs = new MutationObserver(() => scheduleMirror(false));
    if (host) mirror.obs.observe(host, { childList: true, subtree: true });
    mirror.onScroll = () => scheduleMirror();
    // Scroll events do not bubble, and x.com scrolls <body> rather than the
    // document, so this listener on window never fired ONCE: measured 0 window
    // events against 1100px of real scrolling, which is why the grid sat frozen
    // while the feed moved behind it. Capturing on the document sees the scroll
    // of whichever element the site turns out to use.
    document.addEventListener('scroll', mirror.onScroll, { passive: true, capture: true });
    window.addEventListener('resize', mirror.onResize = () => {
      mirror.pinned = pinnedBottom();
      mirror.top = null;
      positionMirror(); applyMirrorColumns(); scheduleMirror(true);
    }, { passive: true });
    setStatus('GridX: mirroring ' + (SITE ? SITE.label : 'this feed')
      + ' - scroll as usual and posts collect into the grid', 6000);
  }

  function stopMirror() {
    if (!mirror) return;
    if (mirror.obs) mirror.obs.disconnect();
    if (mirror.sizes) mirror.sizes.disconnect();
    document.removeEventListener('scroll', mirror.onScroll, { capture: true });
    window.removeEventListener('resize', mirror.onResize);
    try { mirror.root.remove(); } catch (e) {}
    document.documentElement.classList.remove('gridx-mirror-on');
    mirror = null;
  }

  // How far down does the site's own pinned chrome reach? On x.com that is the
  // sticky "For you / Following" tab strip: 54px that stays put no matter how
  // far the reader scrolls. Only bars pinned to the top edge RIGHT NOW count -
  // the composer is sticky too, but it scrolls away, and counting it as chrome
  // is what left a permanent gap for the live feed to show through.
  function pinnedBottom() {
    let bottom = 0;
    const consider = (el) => {
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { return; }
      if (cs.position !== 'sticky' && cs.position !== 'fixed') return;
      let b;
      try { b = el.getBoundingClientRect(); } catch (e) { return; }
      if (b.height < 8 || b.height > 220) return;
      if (b.top > 2 || b.bottom <= 0) return;
      if (b.bottom > bottom) bottom = b.bottom;
    };
    // Walk the feed's own ancestor chain and look only at what sits BEFORE it.
    // Scanning the whole column would mean a getBoundingClientRect per node on
    // a page holding thousands of them; the tab strip is always inside an
    // earlier sibling of one of these ancestors, a subtree of a few dozen.
    let el = host;
    let hops = 0;
    while (el && el !== document.body && hops++ < 14) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
        consider(sib);
        let inner = null;
        try { inner = sib.querySelectorAll('div, header, nav, section'); } catch (e) {}
        if (inner) for (let i = 0; i < inner.length && i < 200; i++) consider(inner[i]);
      }
      el = el.parentElement;
    }
    return Math.round(bottom);
  }

  // Cover the timeline column and the dead space to its right, and start below
  // whatever the site keeps pinned at the top. Anchoring to <main> covered the
  // whole window - X's own left nav and tab strip included - which made the
  // page look broken rather than gridded.
  function positionMirror() {
    if (!mirror) return;
    const col = document.querySelector('[data-testid="primaryColumn"]') || host;
    let r;
    try { r = col.getBoundingClientRect(); } catch (e) { return; }
    // The feed's top edge is the right place to start ONLY while the composer
    // above it is still on screen. It used to be measured once, at load, and
    // never again - so the moment the reader scrolled, that same band filled
    // with the site's real posts sliding past above a grid that never moved.
    // A live strip of feed on top of a frozen grid is exactly the reported bug;
    // clamping to the pinned chrome and re-measuring every tick is the fix.
    const pinned = mirror.pinned || 0;
    let top = pinned;
    try {
      const hr = host.getBoundingClientRect();
      top = Math.max(pinned, Math.min(window.innerHeight - 80, Math.round(hr.top)));
    } catch (e) {}
    const left = Math.round(r.left);
    // clientWidth, not innerWidth: innerWidth counts the scrollbar, so the
    // overlay reached under it and painted its background over the track.
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const width = Math.max(200, Math.round(vw - left - 8));
    if (top === mirror.top && left === mirror.left && width === mirror.width) return;
    mirror.top = top;
    mirror.left = left;
    mirror.width = width;
    mirror.root.style.left = left + 'px';
    mirror.root.style.width = width + 'px';
    mirror.root.style.top = top + 'px';
    mirror.root.style.height = Math.max(80, window.innerHeight - top) + 'px';
    try {
      mirror.root.style.background = getComputedStyle(document.body).backgroundColor || '#fff';
    } catch (e) {}
  }

  function applyMirrorColumns() {
    if (!mirror) return;
    const requested = clampInt(settings.columnCount, 1, 8);
    const min = (SITE && SITE.minColumn) || 200;
    const w = mirror.root.getBoundingClientRect().width || window.innerWidth;
    const gap = (settings.bleed ? 0 : 8) * densityScale();
    const fits = Math.max(1, Math.floor((w + gap) / (min + gap)));
    const cols = Math.max(1, Math.min(requested, fits));
    mirror.cols = cols;
    mirror.gap = gap;
    // Below ~260px a post stops fitting: X's header collapses to a bare badge
    // and timestamp with the display name gone, and the action row runs past
    // the cell edge. Refusing the column was one answer, and it is why asking
    // for six columns silently gave four. Scaling the whole post is a better
    // one - it keeps every proportion, so a narrow column reads as a smaller
    // post rather than a broken one. Safe here in a way it never was on X's
    // own cells: these clones are in normal flow inside GridX's own grid.
    const colW = (w - gap * (cols - 1)) / cols;
    const prevW = mirror.colW; const prevZoom = mirror.zoom;
    mirror.colW = colW;
    const zoom = colW >= COMFORT_COLUMN ? 1 : Math.max(0.6, colW / COMFORT_COLUMN);
    mirror.zoom = zoom;
    mirror.inner.style.setProperty('--gx-cell-zoom', zoom.toFixed(3));
    stats.columnCount = cols;
    stats.effectiveColumns = cols;
    mirror.inner.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    mirror.inner.style.columnGap = gap + 'px';
    // Every cell just changed width (and possibly zoom), so every cached
    // height is stale. Mark them, do not measure here: the read pass in
    // packMirror does it in one go, after all the writes.
    if (prevW !== colW || prevZoom !== zoom) {
      for (const cell of mirror.inner.children) dirtyCells.add(cell);
    }
  }

  // Walk the feed's own cells rather than every <article>: a quoted post is an
  // <article> nested inside another, so querying articles directly captured the
  // quote as a separate cell and mismatched permalinks. Taking the OUTERMOST
  // article in each cell also lets ads through, which carry no /status/ link -
  // keying only on permalink silently dropped half the feed (measured: 6 cells
  // captured from 12 mounted articles).
  function cellKey(cell, art) {
    let url = '';
    try { url = (SITE.permalink(art) || ''); } catch (e) {}
    if (url) return url;
    const t = (art.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return t ? 'txt:' + t : '';
  }

  // Heights are read ONCE per clone, in a pass that writes nothing, and after
  // that they come from the ResizeObserver's own numbers. packMirror used to
  // call getBoundingClientRect on every clone and write its placement right
  // after each read, which forces a synchronous layout per cell: measured 4
  // long tasks totalling 356ms for a single ten-tick scroll holding only 19
  // clones, and the cost grows with everything the session collects.
  const heights = new WeakMap();
  const rawHeights = new WeakMap();
  let dirtyCells = new Set();
  function measureNewCells() {
    if (!mirror) return;
    const todo = [];
    for (const cell of mirror.inner.children) if (!heights.has(cell)) todo.push(cell);
    for (const cell of dirtyCells) if (cell.isConnected) todo.push(cell);
    dirtyCells.clear();
    // getBoundingClientRect, not offsetHeight: a cell in a narrow column is
    // ZOOMED, and offsetHeight reports the height before the zoom while the
    // grid lays out the height after it. Measuring the wrong one leaves a
    // proportional gap under every cell.
    // Reads only - no style is written until the loop is over.
    for (const cell of todo) heights.set(cell, cell.getBoundingClientRect().height || 0);
  }

  // A post is cloned the instant it mounts, and at that moment X has usually
  // not filled in the avatar or the photo yet. Measured on the live account:
  // 16 clones holding 8 <img> between them, from live posts carrying three to
  // five EACH - which is why the grid showed grey avatar circles and empty
  // white media boxes and never healed. While the source post is still
  // mounted, take the picture again.
  // X sizes its media boxes in JavaScript, in pixels, against its own 600px
  // column and writes the numbers inline - a photo arrives in the clone with
  // width:492px inside a 308px grid cell, and the cell's overflow:hidden then
  // crops it. Inline styles beat any stylesheet, so trade the fixed box for
  // its aspect ratio and let the column decide the width. Anything narrower
  // than an avatar is left alone.
  function fitMedia(clone) {
    let boxes;
    try { boxes = clone.querySelectorAll('[style*="width"]'); } catch (e) { return; }
    for (const el of boxes) {
      const w = parseFloat(el.style.width);
      const h = parseFloat(el.style.height);
      if (!(w > 120)) continue;
      if (h > 0) {
        el.style.aspectRatio = (w / h).toFixed(4);
        el.style.height = 'auto';
      }
      el.style.width = '100%';
      el.style.maxWidth = '100%';
    }
  }

  const REFRESH_LIMIT = 4;

  // Is the copy behind the post it came from? Pictures were the obvious case,
  // but TEXT arrives late too: measured on the live feed, a promoted post
  // whose clone held 37 characters while the post itself had grown to 79 - the
  // reader sees a cell with a line and a half and an action row, and nothing
  // else. Image count alone cannot see that, since both had exactly one.
  function staleClone(clone, art) {
    let liveImgs = 0, mineImgs = 0, liveLen = 0, mineLen = 0;
    try {
      liveImgs = art.querySelectorAll('img').length;
      mineImgs = clone.querySelectorAll('img').length;
      liveLen = (art.textContent || '').length;
      mineLen = (clone.textContent || '').length;
    } catch (e) { return false; }
    if (liveImgs > mineImgs) return true;
    // A margin, so a relative timestamp ticking from 8h to 9h or a like count
    // rolling over does not keep re-cloning a post that is already complete.
    if (liveLen - mineLen > 12) return true;
    // A post still spinning when it was copied stays spinning forever.
    try {
      if (clone.querySelector('[role="progressbar"]') &&
          !art.querySelector('[role="progressbar"]')) return true;
    } catch (e) {}
    return false;
  }

  function refreshClone(clone, art, key) {
    const tries = clone.__gxRefresh || 0;
    if (tries >= REFRESH_LIMIT) return false;
    if (!staleClone(clone, art)) return false;
    let next;
    try { next = art.cloneNode(true); } catch (e) { return false; }
    next.classList.add('gx-mirror-cell');
    fitMedia(next);
    next.__gxRefresh = tries + 1;
    if (clone.dataset.gxUrl) next.dataset.gxUrl = clone.dataset.gxUrl;
    // Keep the cell where it already sits; only its height is now unknown.
    next.style.gridColumnStart = clone.style.gridColumnStart;
    next.style.gridRowStart = clone.style.gridRowStart;
    next.style.gridRowEnd = clone.style.gridRowEnd;
    if (mirror.sizes) { try { mirror.sizes.unobserve(clone); } catch (e) {} }
    try { clone.replaceWith(next); } catch (e) { return false; }
    heights.delete(next);
    mirror.seen.set(key, next);
    if (mirror.sizes) { try { mirror.sizes.observe(next); } catch (e) {} }
    return true;
  }

  function captureIntoMirror() {
    if (!mirror) return 0;
    // A detached node emits no mutations ever again, so if the site swapped its
    // feed container the observer is dead and capture stops without a sound -
    // which looks exactly like "it only ever collects the first few posts".
    if (!host || !host.isConnected) {
      const next = findHost();
      if (!next) return 0;
      host = next;
      if (mirror.obs) {
        mirror.obs.disconnect();
        mirror.obs.observe(host, { childList: true, subtree: true });
      }
      mirror.pinned = pinnedBottom();
      mirror.top = null;
      positionMirror();
      log('mirror re-attached to a rebuilt feed container');
    }
    let added = 0;
    for (const cell of host.children) {
      if (!isEl(cell)) continue;
      let art = null;
      try { art = cell.matches(ARTICLE) ? cell : cell.querySelector(ARTICLE); } catch (e) { continue; }
      if (!art) continue;
      const key = cellKey(cell, art);
      if (!key) continue;
      const have = mirror.seen.get(key);
      if (have) { if (refreshClone(have, art, key)) added++; continue; }
      let clone;
      try { clone = art.cloneNode(true); } catch (e) { continue; }
      if (key.indexOf('txt:') !== 0) clone.dataset.gxUrl = key;
      clone.classList.add('gx-mirror-cell');
      fitMedia(clone);
      mirror.seen.set(key, clone);
      mirror.order.push(key);
      mirror.inner.appendChild(clone);
      if (mirror.sizes) mirror.sizes.observe(clone);
      added++;
    }
    // Bound the memory a long session can accumulate.
    while (mirror.order.length > MIRROR_CAP) {
      const drop = mirror.order.shift();
      const el = mirror.seen.get(drop);
      if (el) { try { el.remove(); } catch (e) {} }
      mirror.seen.delete(drop);
    }
    return added;
  }

  function packMirror() {
    if (!mirror) return 0;
    const cols = mirror.cols || 1;
    const gap = mirror.gap || 8;
    measureNewCells();
    const colRows = new Array(cols).fill(0);
    for (const cell of mirror.inner.children) {
      const h = heights.get(cell) || 0;
      if (!h) continue;
      const span = Math.max(1, Math.ceil((h + gap) / ROW_UNIT));
      // Shortest column, not round robin. Round robin gave every column the
      // same NUMBER of posts however tall they were, so a column that drew
      // three photo posts ran a screen and a half past one that drew three
      // one-liners - those are the blank half-screens in the grid.
      let c = 0;
      for (let k = 1; k < cols; k++) if (colRows[k] < colRows[c]) c = k;
      setPlacement(cell, c + 1, colRows[c] + 1, span);
      colRows[c] += span;
    }
    let tallest = 0;
    for (const r of colRows) if (r > tallest) tallest = r;
    return tallest * ROW_UNIT;
  }

  // Whatever element the page really scrolls, read the position from there.
  function pageScrollTop() {
    let best = 0;
    const els = [document.documentElement, document.body, host];
    for (const el of els) {
      if (!el) continue;
      try { if (el.scrollTop > best) best = el.scrollTop; } catch (e) {}
    }
    return best;
  }

  // Where in the feed is the reader? The site's own mounted cells answer that
  // exactly, and matching the topmost one to its clone beats mapping scroll
  // fractions: the site's scroll height is its VIRTUAL height and bears no
  // fixed relation to the height of the grid collected so far, so the fraction
  // drifted every time X extended its range. Returns -1 when nothing mounted
  // has been captured yet.
  function mirrorAnchorOffset() {
    if (!mirror || !host) return -1;
    const edge = (mirror.top || 0) + 4;
    const rows = [];
    for (const cell of host.children) {
      if (!isEl(cell)) continue;
      let b;
      try { b = cell.getBoundingClientRect(); } catch (e) { continue; }
      if (b.height < 4) continue;
      let art = null;
      try { art = cell.matches(ARTICLE) ? cell : cell.querySelector(ARTICLE); } catch (e) { continue; }
      if (!art) continue;
      const key = cellKey(cell, art);
      const clone = key ? mirror.seen.get(key) : null;
      if (!clone) continue;
      rows.push({ top: b.top, height: b.height, clone: clone });
    }
    if (!rows.length) return -1;
    rows.sort((a, b) => a.top - b.top);
    let i = 0;
    while (i < rows.length - 1 && rows[i].top + rows[i].height <= edge) i++;
    const cur = rows[i];
    const nxt = rows[i + 1] || null;
    const curTop = Math.max(0, cur.clone.offsetTop);
    // Snapping straight to the anchor's own offset moved the grid ONLY when
    // the anchor changed - one jump per post, roughly 120px at four columns,
    // which is exactly the stutter that reads as "glitchy". Carrying the
    // fraction of the anchor already scrolled past the top edge makes the
    // grid travel with the wheel instead of behind it.
    const frac = cur.height > 0
      ? Math.min(1, Math.max(0, (edge - cur.top) / cur.height))
      : 0;
    const nextTop = nxt
      ? Math.max(curTop, Math.max(0, nxt.clone.offsetTop))
      : curTop + (heights.get(cur.clone) || 0);
    return curTop + (nextTop - curTop) * frac;
  }

  // Scrolling used to re-measure and re-place every clone on each tick - up to
  // 400 getBoundingClientRect calls plus 1200 style writes per 80ms, which is
  // exactly the "slow and glitchy" scroll. Placement only changes when cells
  // are added or one of them resizes, so scrolling now moves the transform and
  // nothing else.
  function syncMirror(repack) {
    if (!mirror) return;
    positionMirror();
    const added = captureIntoMirror();
    if (repack || added) mirror.gridH = packMirror();
    const gridH = mirror.gridH || 0;
    const viewH = mirror.root.clientHeight || window.innerHeight;
    const gridRange = Math.max(0, gridH - viewH);
    let y = mirrorAnchorOffset();
    if (y < 0) {
      // Fall back to the page's own scroll fraction, via pageScrollRange()
      // rather than documentElement: on live x.com <html> is exactly viewport
      // height with zero range, so the old ratio was 0/1 forever and the
      // transform never left translateY(0).
      const range = Math.max(1, pageScrollRange());
      y = Math.min(1, Math.max(0, pageScrollTop() / range)) * gridRange;
    }
    const offset = Math.round(Math.min(gridRange, Math.max(0, y)));
    if (offset !== mirror.offset) {
      mirror.offset = offset;
      mirror.inner.style.transform = 'translateY(' + (-offset) + 'px)';
    }
    stats.postsRendered = mirror.seen.size;
    updateStatsReadout();
  }

  let mirrorTimer = null;
  function scheduleMirror(repack) {
    if (repack) mirrorRepack = true;
    if (mirrorTimer || !mirror) return;
    mirrorTimer = setTimeout(() => {
      mirrorTimer = null;
      const r = mirrorRepack; mirrorRepack = false;
      syncMirror(r);
    }, 60);
  }
  let mirrorRepack = false;

  function standDownVirtualized() {
    virtualizedGiveUp = true;
    // Kill the retry loop first, or it keeps announcing "feed not found" over
    // the top of the explanation - which is exactly what it did on x.com.
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    hideFatal();
    const label = SITE ? SITE.label : 'this site';
    // A modal in the middle of the timeline is the wrong shape for "we are
    // doing nothing here". Say it once, quietly, then remove every trace of
    // GridX from the page: on a site we refuse to touch, leaving a filter bar
    // and a dialog behind is worse than saying nothing at all.
    setStatus('GridX: ' + label + ' renders its timeline virtualized, so the '
      + 'grid would stall after a few posts. Leaving the site as it is.', 7000);
    setTimeout(teardownOverlay, 7600);
    log('stood down: feed is transform-virtualized');
  }

  function teardownOverlay() {
    if (!root) return;
    try { root.remove(); } catch (e) {}
    root = null; fatalEl = null; filterInput = null; keymapEl = null;
    statsEl = null; hintsEl = null;
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

  // The status readout used to print the CONFIGURED column count, so it happily
  // claimed "cols 8" while every post sat full width in a single column. Count
  // the distinct left edges instead: that is what the reader can actually see.
  function measureColumns() {
    if (!host) return 0;
    const xs = new Set();
    let n = 0;
    for (const cell of host.children) {
      if (!isEl(cell) || n >= 12) break;
      if (FILLER && cell.matches && cell.matches(FILLER)) continue;
      try {
        const r = cell.getBoundingClientRect();
        if (r.width > 0) { xs.add(Math.round(r.left)); n++; }
      } catch (e) {}
    }
    return xs.size;
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
    // In mirror mode the feed the reader sees is the mirror, not the site's
    // own mounted window. Filtering the host instead hid posts nobody could
    // see and left the grid untouched, and the post count reported the ~8
    // cells X had mounted rather than the set collected.
    if (mirror) return Array.from(mirror.inner.children);
    return host ? Array.from(host.querySelectorAll(ARTICLE)) : [];
  }

  /* ------------------------------------------------------------------ *
   * Masonry packing.
   *
   * A plain CSS grid makes every row as tall as its tallest cell, so one post
   * with a large image leaves a column-wide hole beside it - measured on live
   * x.com, a 1130px post sat next to a 161px post and cost ~970px of dead
   * space in a single row. The fix is the row-span trick: make the row track
   * tiny and give each cell a span equal to its own height in track units, so
   * cells pack against whatever is above them instead of against a shared row
   * line. `align-items: start` is what makes this measurable - without it the
   * grid would stretch each cell to its span and every height would read back
   * as the track height rather than the content height.
   * ------------------------------------------------------------------ */
  const ROW_UNIT = 4; // px per implicit row track
  let cellGap = 6;    // vertical breathing room, folded into each cell's span

  // A narrower window may no longer carry the column count we picked, so the fit
  // has to be recomputed before the cells are re-packed against it.
  let resizeTimer = null;
  function onViewportResize() {
    if (resizeTimer || !active) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!active || !host) return;
      const cols = fittedColumns(clampInt(settings.columnCount, 1, 8));
      if (cols !== stats.columnCount) {
        stats.columnCount = cols;
        setInline('gridTemplateColumns', 'repeat(' + cols + ', minmax(0, 1fr))');
      }
      scheduleMasonry();
    }, 16);
  }

  // A latch guarded by requestAnimationFrame is a trap: rAF callbacks do not
  // run while the document is hidden, so a pass scheduled in a background or
  // minimised window never fires, the latch never reopens, and every later
  // request returns early - the packing is dead for the rest of the page's
  // life with no error anywhere. That is why cells kept their fallback span on
  // www.reddit.com while old.reddit, which happened to schedule while visible,
  // packed correctly. A timer fires either way, and layout reads are
  // synchronous regardless of paint.
  let masonryTimer = null;
  function scheduleMasonry() {
    if (masonryTimer || !active) return;
    masonryTimer = setTimeout(() => { masonryTimer = null; layoutMasonry(); }, 16);
  }

  function layoutMasonry() {
    if (!active || !host) return;
    // Only meaningful while we own the layout as a grid.
    try {
      if (getComputedStyle(host).display !== 'grid') return;
    } catch (e) { return; }
    const gap = cellGap;
    // Place every cell EXPLICITLY. Two approaches were measured on the live
    // front page and only one is right for a feed.
    //
    // The grid's own auto-placement is "sparse": its cursor only moves forward,
    // so with uneven spans an item lands at the first slot at-or-after the
    // cursor that happens to fit. That put post 8 directly under post 1, ahead
    // of 5, 6 and 7 - rows read 1 2 3 4, then 8 5 6 7, then 11 9 10 12.
    //
    // Classic masonry (always fill the shortest column) packs just as tightly
    // but scrambles the order for the same reason: one column being a single
    // 4px track taller is enough to send the next post somewhere unexpected.
    // A feed is ordered by rank, so an order the reader cannot follow costs
    // more than a ragged bottom edge does.
    //
    // Round-robin keeps both: post i goes to column i % cols and stacks flush
    // under the previous post in that column. Rows read 1 2 3 4, then 5 6 7 8,
    // with post 5 sitting 9px under post 1 - no row-height holes, order intact.
    const cols = Math.max(1, (getComputedStyle(host).gridTemplateColumns || '')
      .split(' ').filter(Boolean).length);
    const colRows = new Array(cols).fill(0);
    let idx = 0;
    for (const cell of host.children) {
      if (!isEl(cell)) continue;
      if (FILLER && cell.matches && cell.matches(FILLER)) continue;
      let h = 0;
      try {
        if (getComputedStyle(cell).display === 'none') continue;
        h = cell.getBoundingClientRect().height;
      } catch (e) { continue; }
      if (!h) { clearPlacement(cell); continue; }
      const span = Math.max(1, Math.ceil((h + gap) / ROW_UNIT));
      const c = idx % cols;
      idx++;
      setPlacement(cell, c + 1, colRows[c] + 1, span);
      colRows[c] += span;
    }
    stats.effectiveColumns = measureColumns();
  }

  // Writing an unchanged value still dirties layout, so every write is guarded.
  function setPlacement(cell, col, row, span) {
    const c = String(col), r = String(row), e = 'span ' + span;
    if (cell.style.gridColumnStart !== c) cell.style.gridColumnStart = c;
    if (cell.style.gridRowStart !== r) cell.style.gridRowStart = r;
    if (cell.style.gridRowEnd !== e) cell.style.gridRowEnd = e;
  }

  function clearPlacement(cell) {
    cell.style.removeProperty('grid-column-start');
    cell.style.removeProperty('grid-row-start');
    cell.style.removeProperty('grid-row-end');
  }

  function clearMasonry() {
    if (!host) return;
    for (const cell of host.children) if (isEl(cell)) clearPlacement(cell);
  }

  // Cells grow after the fact: images decode, embeds resize, "Show more"
  // expands a post. Without watching for that the spans are computed against
  // a height that is already stale and the packing drifts apart.
  let sizeObserver = null;
  function wireSizeObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    if (sizeObserver) sizeObserver.disconnect();
    sizeObserver = new ResizeObserver(() => scheduleMasonry());
    for (const cell of host.children) {
      if (isEl(cell)) { try { sizeObserver.observe(cell); } catch (e) {} }
    }
  }

  function detachSizeObserver() {
    if (sizeObserver) { sizeObserver.disconnect(); sizeObserver = null; }
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
      // Coalesce a burst of mutations into a single pass. This used to latch on
      // requestAnimationFrame, which never fires in a hidden tab - so a burst
      // arriving while the window was in the background left scanQueued stuck
      // true and every subsequent mutation was dropped for good.
      scanQueued = true;
      setTimeout(() => {
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
        try { recomputeFilters(); } catch (e) { log('filter pass failed', e); }
        wireSizeObserver();
        scheduleMasonry();
      }, 16);
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
    const expander = e.target.closest && e.target.closest('.gx-expand');
    if (expander && expander.parentElement) {
      e.preventDefault();
      e.stopPropagation();
      onExpandClick(expander.parentElement);
      return;
    }
    // A clone carries NONE of the site's handlers. Its role="link" wrappers,
    // its like button, its tabindex containers and its images are inert
    // markup, so treating them as "interactive, let the site deal with it"
    // meant a click on almost any part of a mirrored post did nothing at all -
    // and most of a post's surface is one of those. Only a real <a href> can
    // still act for itself here; everything else opens the post.
    const cell = e.target.closest && e.target.closest('.gx-mirror-cell');
    if (cell) {
      if (e.target.closest('a[href]')) return;
      const own = cell.dataset.gxUrl || (SITE ? SITE.permalink(cell) : '');
      if (!own) return;
      e.preventDefault();
      e.stopPropagation();
      openTab(own);
      return;
    }
    // Let the site handle links, buttons, media controls, inputs natively.
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

  /* ------------------------------------------------------------------ *
   * Expand affordance.
   *
   * Both sites clamp post text, and a narrow column clamps it harder, so posts
   * read as truncated with no way to see the rest without leaving the grid.
   * The button is injected on first hover of a cell rather than for every cell
   * up front: a busy feed carries hundreds of cells and only the one under the
   * pointer needs the control.
   * ------------------------------------------------------------------ */
  function onCellHover(e) {
    if (!active || !host) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const cell = t.closest('.gx-stream > *');
    if (!cell || cell.parentElement !== host) return;
    if (FILLER && cell.matches && cell.matches(FILLER)) return;
    if (cell.querySelector(':scope > .gx-expand')) return;
    const btn = document.createElement('button');
    btn.className = 'gx-expand';
    btn.type = 'button';
    btn.title = 'Show the full post (e)';
    btn.setAttribute('aria-label', 'Show the full post');
    btn.textContent = '⇲';
    cell.appendChild(btn);
  }

  function onExpandClick(cell) {
    const on = cell.classList.toggle('gx-expanded');
    const post = cell.matches(ARTICLE) ? cell : cell.querySelector(ARTICLE);
    if (post) post.classList.toggle('gx-expanded', on);
    const btn = cell.querySelector(':scope > .gx-expand');
    if (btn) btn.textContent = on ? '⇱' : '⇲';
    scheduleMasonry();
  }

  /* ------------------------------------------------------------------ *
   * Route awareness.
   *
   * These are single-page apps: opening a post swaps the timeline for one
   * post without a page load, so the content script never re-runs and the grid
   * kept applying to the permalink view. Watch the URL and stand down there.
   * ------------------------------------------------------------------ */
  function isFeedRoute() {
    if (!SITE || !SITE.feedRoute) return true;
    try { return !!SITE.feedRoute(location.pathname); } catch (e) { return true; }
  }

  // Tracks whether WE stood the grid down for the route, so returning to a feed
  // only revives a grid the route turned off - never one the user switched off.
  let standDown = false;
  let routeHref = location.href;
  let routeTimer = null;
  function startRouteWatch() {
    if (routeTimer) return;
    routeTimer = setInterval(() => {
      if (location.href === routeHref) return;
      routeHref = location.href;
      onRouteChange();
    }, 400);
  }

  function stopRouteWatch() {
    if (routeTimer) { clearInterval(routeTimer); routeTimer = null; }
  }

  function onRouteChange() {
    if (!isFeedRoute()) {
      if (active) {
        standDown = true;
        deactivate();
        setStatus('GridX stands down on a single post', 4000);
      }
      return;
    }
    if (!active && standDown) {
      // The feed is rebuilt from scratch on the way back; give it a beat.
      setTimeout(() => {
        if (!active && standDown && isFeedRoute()) { standDown = false; activate(); }
      }, 500);
    }
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
    if (virtualizedGiveUp) return;
    ensureOverlay();
    hideFatal();
    host = findHost();
    if (!host) {
      // No dialog while the page is still building its feed. On a cold x.com
      // load the timeline arrives a second or two after the content script,
      // and this used to throw a red "feed not found" panel across the column
      // on every single load, which then disappeared by itself. Say nothing
      // until the retries are genuinely exhausted.
      scheduleRetry();
      return;
    }
    // Decide before we restyle anything. A feed that places its own posts
    // cannot be re-flowed in place, but it CAN be mirrored: leave it alone
    // entirely and build the grid from clones as posts mount.
    if (isTransformVirtualized(host)) {
      active = true;
      document.documentElement.classList.add(CLASS_ACTIVE);
      document.documentElement.classList.add('gridx-site-' + SITE.id);
      startMirror();
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeydown, true);
      startStats();
      log('mirror mode: feed is transform-virtualized');
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
    wireSizeObserver();
    scheduleMasonry();
    window.addEventListener('resize', onViewportResize, { passive: true });
    startHealth();
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('mouseover', onCellHover, true);
    startStats();
    setStatus('GridX active on ' + (SITE ? SITE.label : 'this site'));
    log('activated on', host);
  }

  function wireToHost() {
    // (retained as a no-op for call-site clarity; handlers are document-level)
  }

  function scheduleRetry() {
    if (retryTimer || virtualizedGiveUp) return;
    let tries = 0;
    retryTimer = setInterval(() => {
      tries++;
      if (findHost()) { clearInterval(retryTimer); retryTimer = null; if (!active) activate(); return; }
      if (tries > 10) { clearInterval(retryTimer); retryTimer = null; if (root && !active) showFatal('GridX: could not find the timeline after several attempts.'); }
    }, 1500);
  }

  // A deliberate toggle from the popup or the keyboard clears the give-up flag:
  // the user asking for the grid again is the one signal that should override
  // our own decision to stay off.
  function resetGiveUp() { virtualizedGiveUp = false; unvirtBlocked = false; }

  function deactivate() {
    if (!active) return;
    detachObserver();
    stopHealth();
    stopStats();
    stopPaginationWatch();
    stopMirror();
    detachSizeObserver();
    window.removeEventListener('resize', onViewportResize);
    clearMasonry();
    untagWidenChain();
    restoreHost();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('mouseover', onCellHover, true);
    for (const b of document.querySelectorAll('.gx-expand')) b.remove();
    for (const c of document.querySelectorAll('.gx-expanded')) c.classList.remove('gx-expanded');
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

  function showFatal(msg, title) {
    if (!fatalEl) return;
    const ps = fatalEl.querySelectorAll('p');
    // The heading is markup, so a caller that only replaced the body left the
    // default "feed not found" standing above an unrelated message.
    const h = fatalEl.querySelector('h1, h2, h3, strong');
    if (h && title) h.textContent = title;
    if (msg && ps[1]) ps[1].textContent = msg;
    if (ps[0]) ps[0].hidden = !!title;
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
      ' · cols ' + (stats.effectiveColumns || stats.columnCount) +
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
    // Asking for the grid by hand overrides our own decision to stay off a
    // feed we judged un-griddable, so the user always gets the last word.
    if (cmd === 'toggle-grid') { if (active) deactivate(); else { resetGiveUp(); hideFatal(); activate(); } }
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

  // ...but e.target is RETARGETED at a shadow boundary. Type in Reddit's search
  // box and the event reports <faceplate-search-input>, not the <input> inside
  // it, so the check above saw a non-editable element and GridX swallowed the
  // keystroke - which is why 's' (and f, p, j, k, o...) went missing mid-search.
  // composedPath is the only view of the event that crosses shadow roots.
  function editableLike(t) {
    if (!t || t.nodeType !== 1) return false;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    const role = t.getAttribute && t.getAttribute('role');
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  }

  function deepActiveElement() {
    let el = document.activeElement;
    let hops = 0;
    while (el && el.shadowRoot && el.shadowRoot.activeElement && hops++ < 10) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function inTypingContext(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) if (editableLike(n)) return true;
    return editableLike(deepActiveElement()) || editableLike(e.target);
  }

  // Cached because every cursor move used to rebuild it: a full querySelectorAll
  // plus a filter across the whole feed, per keypress. Invalidated whenever the
  // post set or the hidden set changes.
  let listCache = null;
  function invalidateList() { listCache = null; }
  function list() {
    if (listCache) return listCache;
    listCache = articles().filter((a) => !a.classList.contains('gx-hidden'));
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
    // A mirrored cell must never be scrolled to: the overlay does not scroll,
    // so the browser would satisfy the request by scrolling the PAGE, which
    // moves the site's feed under the grid and drags the grid along with it.
    if (mirror && mirror.inner.contains(a)) return;
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
  // Expand the post under the cursor. This used to toggle a class that no
  // stylesheet responded to, so the key did nothing at all; the class now
  // un-clamps the text and the cell grows to fit. Toggling the CELL (not the
  // post) is what lets the box itself grow inside the grid.
  function toggleCursor() {
    if (!cursorArticle) { setStatus('no post under cursor'); return; }
    const cell = cellOf(cursorArticle);
    const on = cell.classList.toggle('gx-expanded');
    cursorArticle.classList.toggle('gx-expanded', on);
    scheduleMasonry();
  }
  function toggleKeymap() { if (keymapEl) keymapEl.hidden = !keymapEl.hidden; }
  function clearCursorOrClose() {
    if (keymapEl && !keymapEl.hidden) { keymapEl.hidden = true; return; }
    if (cursorArticle) { cursorArticle.classList.remove('gx-cursor'); cursorArticle = null; setStatus('cursor cleared'); }
  }

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    // Never fight a browser or site chord: Ctrl/Cmd/Alt combinations are not ours.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (inTypingContext(e)) {
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
      case 'x': case 'e': toggleCursor(); break;
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
    startRouteWatch();
    if (isFeedRoute()) activate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();