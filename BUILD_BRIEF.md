# GridX — High-Density Twitter/X Dashboard Browser Extension

Build a complete, installable Chrome (Manifest V3) browser extension in this directory
(`/home/lenovo/x-dashboard-grid`). It turns the live X (twitter.com) web app into a
high-density, multi-column "grid dashboard" for scanning dozens of posts at once with
extremely high information-transfer rate and fast scrolling/scanning.

## Deliverables (files you MUST create)

```
manifest.json
src/content/content.js        # grid renderer + keyboard nav + filters
src/content/content.css       # high-density grid styles
src/popup/popup.html          # column count, density, toggles, filter box, stats
src/popup/popup.js
src/popup/popup.css
src/options/options.html      # defaults, keyboard map, filter presets, column presets
src/options/options.js
src/options/options.css
icons/icon16.png icons/icon48.png icons/icon128.png   # generate programmatically
RESEARCH.md                   # platform/API constraints + risk analysis (see section 5)
README.md                     # install, usage, keyboard map, troubleshooting
test/fixture.html             # local test page with fake X timeline DOM (see section 6)
test/smoke_test.py            # Playwright smoke test (see section 6)
```

No build step, no bundler, no framework. Vanilla JS only (ES2022, no modules needed in
content script; use IIFE). No external dependencies, no remote code (MV3).

## 1. Core architecture

- **Manifest V3.** `manifest_version: 3`, name "GridX — High-Density X Dashboard",
  version 0.1.0. Permissions: `storage` only. Content script matches:
  `https://x.com/*`, `https://twitter.com/*`, plus `http://localhost/*` and
  `http://127.0.0.1/*` (dev-only hook for the smoke test — note this in README).
  Declare `action` (popup), `options_page` (or `options_ui` open_in_tab), `commands`
  with at least: `toggle-grid` (Ctrl+Shift+G / on Mac Cmd+Shift+G), `toggle-pause`
  (Ctrl+Shift+P). Keep a minimal service worker (background.js) that only instantiates
  commands and relays messages — the bulk of logic lives in the content script.
- **Content script strategy — "DOM hoisting", fully read-only.**
  - The user must be logged into x.com normally. The extension NEVER calls the X API,
    NEVER reads cookies, NEVER automates writes (no auto-like/RT/follow), NEVER
    programmatically scrolls the page.
  - Strategy: hide X's own chrome (top header, left nav rail, right sidebar, the
    `[data-testid="primaryColumn"]` wrappers) with CSS, take the primary timeline
    container, and re-parent every feed `article` (tweet node) into the extension's
    own CSS grid inside a `#gridx-root` container that fills the viewport.
  - Use a `MutationObserver` on the primary column: when X's infinite scroll appends
    new articles, hoist them into the grid immediately. When articles are removed
    (X virtualizes them), move them out of the grid to a hidden stash div instead of
    destroying them, so X's observer callbacks still work: the source of truth stays
    X's DOM; the grid is a re-parented view of the same nodes. When X re-inserts an
    article node we know (dataset marker), just re-parent it back into the grid.
  - **Resilient selectors.** X changes markup. Define selector candidates in one config
    object with fallbacks, e.g. article: `article[data-testid="tweet"], article`. Primary
    column: `[data-testid="primaryColumn"], main section`, timeline href anchors:
    `a[href*="/status/"]`. Feature-detect at init; if nothing matches, show a clear
    "GridX: timeline not found — reload or update selectors" overlay instead of
    breaking the page. Never crash X itself; on fatal error remove the grid and restore
    the original DOM layout (remove `gridx-active` class from `<html>`).
  - **No X API, no cookies, no webRequest, no tabs permission** — this is the
    risk-minimization core, document it in RESEARCH.md.
- **State.** All settings in `chrome.storage.local` under a single `gridxSettings`
  object (columnCount, density, fontScale, showMedia, showAvatars, showMetrics,
  hideRetweets, hidePromoted, hideVerified, filterKeywords[], filterHandles[],
  extraCss, scanMode). Runtime state (paused, stats) in memory + storage counters.
- **Popup → content messaging.** Popup sends `{type:'gridx:update', settings}` via
  `chrome.tabs.query` + `chrome.tabs.sendMessage` (needs no tabs permission for
  sendMessage to the active tab if using `chrome.tabs.query({active:true,...})` —
  actually querying active tab requires no extra permission in MV3 for the popup
  context; if the linter complains, use the `scripting` permission? NO — avoid
  `scripting`. Use `chrome.tabs.query` which works from popup without permission
  when only reading the active tab's id for sendMessage. Verify this works; document in
  README if an exception is needed.)

## 2. Grid features (the core UX)

- **Adjustable columns: 1–8** slider in popup and options (default 3). Grid uses
  `display:grid; grid-template-columns: repeat(N, minmax(0,1fr));` full-bleed, no
  page scrollbar on the X document — the grid root itself scrolls vertically
  (`overflow-y:auto; overscroll-behavior:contain`).
- **Density modes:** `compact` (default), `cozy`, `roomy`. Compact = maximum info per
  cell: tighten paddings to ~6px, avatar 20px, text 12.5–13px, one-line meta,
  line-height 1.25, collapse all tweet chrome. Cozy/roomy scale up proportionally.
- **Font scale:** 0.8×–1.4× slider (multiplies base font size, affects cells only).
- **Scan mode** (`scan` toggle, hotkey `s`): jumps to max columns (8), compact density,
  hide avatars, hide media, hide metrics, font 0.9× — absolute maximum information
  transfer. Toggling restores prior settings.
- **Per-cell rendering (keep the cell tiny):**
  - One meta line: avatar (16–22px), display name, handle, timestamp, and an
    "≡" overflow button. Hide verified badge in compact unless `showVerified`.
  - Tweet text: full text, small font, 2-line clamp by default (`-webkit-line-clamp`)
    with full text on hover/click (click the cell body to expand in place).
  - Media: hidden by default with a `[image]` / `[gif]` / `[video]` chip; click chip to
    expand media in-cell. When `showMedia` is on, show small thumbnails (images max
    120px tall, object-fit cover).
  - Metrics (replies/RTs/likes/views) condensed to one row with compact icons: e.g.
    `↩ 12 · ⟳ 34 · ♥ 56 · 👁 7k`, hidden in scan mode / when `showMetrics` off.
  - Quoted tweets collapse to a single line: `❝ @handle: first 60 chars…`.
  - Ad/promoted posts (`a[aria-label*="sponsored"]`, `div` containing "Ad") get a
    subtle `AD` badge and are hidden when `hidePromoted`.
  - Retweets: collapse the "Reposted" header into the meta line as `↻ @user`, or hide
    entirely when `hideRetweets`.
- **Information-transfer extras:**
  - `content-visibility: auto` + `contain-intrinsic-size` on grid cells so off-screen
    cells skip rendering (fast scroll).
  - No smooth scrolling anywhere (`scroll-behavior: auto !important`).
  - CSS `!important` overrides to kill X's animations/transitions on the grid path.
  - 「bleed mode」 option: grid spans full viewport width edge-to-edge (kill the
    remaining gutter).
- **Filters (typeahead filter bar at top of grid):** keyword filters (comma separated),
  handle filters (+@keep, -@drop), `min:rt>N` to only show tweets with >N reposts? No —
  keep it simple: keyword include/exclude + handle include/exclude. Enter applies,
  Esc clears. Applied filters also work incrementally as new posts stream in.
- **Stats line** (popup + a small bar on the grid): posts rendered, filtered out,
  grid active time, column count.

## 3. Keyboard navigation (in-page, vim-flavored)

Implemented in content script keydown handler on the grid root (not the `commands`
API, so any key can bind). Defaults:

- `j`/`↓` next post, `k`/`↑` previous post (moves a highlight ring `gridx-cursor`).
- `h`/`←` previous column, `l`/`→` next column (horizontal cursor jump).
- `g` top, `G` bottom, `d` half-page down, `u` half-page up, `Space` page down,
  `Shift+Space` page up.
- `Enter` open tweet in new tab (or same tab — decide: new tab, non-focused via
  `window.open(url,'_blank','noopener')`… better: append a real `<a target="_blank">`
  click so it's a user gesture + normal link).
- `o` open original tweet in same tab (replace view), `backspace` go back.
- `x` expand/collapse current cell text, `m` toggle media on current cell,
  `f` focus filter bar, `s` scan mode toggle, `p` pause/resume grid.
- `?` show/hide overlay keymap.
- Esc: close filter / clear cursor.
Cursor scrolls into view (`scrollIntoView({block:'nearest'})`). All keys ignored when
typing in an input/textarea or contenteditable. Show transient key hints in a status
bar at the bottom of the grid (auto-hide 2s).

## 4. Popup + Options

- **Popup** (compact, ~280px wide): column slider (1–8, live), density segmented
  control (compact/cozy/roomy), toggles: Media, Metrics, Avatars, Promoted filter,
  Retweets, Scan mode, Pause. A text input for quick keyword filter. Live stats row.
  "Open options" link. Every control writes settings and pushes update message to the
  active tab(s) immediately.
- **Options page** (tab): all of the above as full-page with persistence + presets.
  "Column presets": save current settings as named preset (e.g. "Dense", "Scan"),
  load/delete presets. "Keyboard map": table of all bindings (read-only for v1).
  "Extra CSS" textarea appended to content.css at runtime (advanced users) with an
  "Apply" button and a "Reset to defaults" button. Filter presets: save/load keyword+
  handle filter sets.

## 5. RESEARCH.md — platform/API constraints + risk analysis (write this as real research)

Cover, with citations (URLs) where possible:

1. **X API landscape (2026):** free tier = write-only-ish (v2 write access), read is
   restricted (per-project read limits, ~1M posts/month or less depending on plan;
   search API free tier returns sampled results ~0.1–3%), enterprise/basic tiers cost
   money, `x-api` access requires a developer app + OAuth 2.0 PKCE with user tokens +
   refresh. Why the extension does NOT use the API: server-side secret can't ship in an
   extension; free tier can't deliver a full chronological home timeline; ToS of the
   developer agreement restricts "replicate the chronological home timeline".
   Rate limits table for free vs basic: cite current docs.
2. **Web scraping / ToS risk:** X ToS + Automation rules prohibit scraping without
   prior permission and prohibit API circumvention. Argue why GridX is in the
   **browser-extension / assistive-view** class (like ad-blockers, dark-mode toggles,
   uBlock) and NOT scraping: it performs zero network requests to X beyond what the
   official client already makes, stores nothing server-side, re-renders DOM the user
   already loaded, is read-only, and requires the user's own authenticated session.
   Cite the ToS sections and the legal/ToS risk posture; note that X's own web app
   ships TweetDeck (X Pro) as the official multi-column answer, and GridX's differentiator
   is density + free tier.
3. **Account risk:** enumerate the surface — no writes, no automation, no cookie
   access, no API tokens, no mass fetch, normal human scroll cadence (no auto-scroll),
   fingerprinting surface identical to the official client. Residual risks: X can change
   DOM (maintenance risk, not ban risk); AV/enterprise policy; ToS gray zone on DOM
   manipulation increasing if users automate. Mitigations list.
4. **MV3 constraints:** no remote code, no inline scripts in popup/options (CSP),
   service worker lifetime limits, `chrome.storage.sync` 8KB/item vs `local` limits,
   content-script world vs isolated world tradeoffs (we run in ISOLATED world — note:
   grid re-parenting X's nodes with our CSS requires care because our CSS selectors
   match X's DOM classes — use our own wrapper classes, not X's, for styling; the
   original X styles may fight us — handle with nested `#gridx-root` scoped CSS +
   `!important` where needed).
5. **Design consequence table:** constraint → chosen design → residual risk.

Keep RESEARCH.md honest and balanced (it's the "acceptable account/platform risk"
deliverable): state clearly what is safe, what is gray, and what you deliberately did
NOT build (auto-scroll bots, API integration, multi-account, posting automation, mass
export).

## 6. Test fixture + smoke test (PROVE it works)

Create `test/fixture.html`: a static page that mimics X's timeline DOM sufficiently for
the content script: a `div[data-testid="primaryColumn"]` containing a scrollable timeline
`section` with ~30 `article[data-testid="tweet"]` nodes, each with realistic structure:
`div[data-testid="UserAvatar-Container"] img`, `a[href*="/status/"]`, name/handle spans,
tweet text `div[data-testid="tweetText"]`, action bar `div[role="group"]`, timestamps,
a couple of promoted articles (with `a[aria-label*="sponsored"]`), one reposted
(`span` containing "Reposted"), one with quoted content, a couple with image media
(`div[data-testid="tweetPhoto"] img`). Include a "load more" button that appends 5 more
articles when clicked (to test the MutationObserver path).

Create `test/smoke_test.py` (Playwright, Python) that:
- Launches Chrome for Testing from `/tmp/pw-browsers/...` (find it by glob), headful
  (WSLg) with `--load-extension=<repo>/ --disable-extensions-except=<repo>/`
  `--disable-web-security maybe NOT — avoid; use --no-sandbox`.
- Opens `http://localhost:8765/fixture.html` — so the smoke test must ALSO start a
  tiny `python3 -m http.server 8765 --directory test` in a thread before launching
  the browser (serve the fixture; require the extension's content script localhost
  match).
- Asserts: (1) a `#gridx-root` element exists in the page; (2) at least 20 articles were
  hoisted into the grid; (3) grid has exactly the configured number of CSS columns
  (read computed style of `#gridx-root` — grid-template-columns count); (4) clicking
  the fixture's "load more" grows the grid article count (MutationObserver proof);
  (5) sending a `gridx:update` message with columnCount=4 changes the computed column
  count; (6) a keyword filter hides matching posts; (7) scan mode toggle applies
  `gridx-scan` class to html. Use `context.background`/`service_workers` to discover the
  extension id if needed (per known Playwright quirks: headless must be False, must use
  full chrome binary not headless shell, must pass --disable-extensions-except).
- Print PASS/FAIL per check; exit nonzero on any failure. Rely on `page.evaluate` to
  read DOM/computed styles since it's a content-script DOM.
- Skip gracefully (exit 0 with a note) if Chrome for Testing binary is not found.

## 7. Hard requirements / quality bar

- Vanilla JS, ES2022, zero dependencies. All files lint-clean (`node --check`).
- `manifest.json` valid JSON and permissions minimal: `storage` ONLY (plus optional
  `commands` and `action`/`options_ui` which need no permission). DO NOT add
  `webRequest`, `cookies`, `tabs` (only if unavoidable for sendMessage — verify),
  `scripting`, `host_permissions` beyond content script matches.
- Content script must never break X when selectors fail: fail-safe overlay + restore.
- No console spam. A single `[gridx]` prefix for debug logs behind a `debug` flag.
- README.md: features, install (chrome://extensions → Load unpacked), keyboard map,
  options/presets guide, troubleshooting (timeline not found, X layout changed, cell
  rendering issues, how to reset), dev notes (localhost test hook), risk summary
  pointing to RESEARCH.md.
- Comments in code explaining WHY selectors are layered, WHY nodes are stashed not
  removed (X observer contract), etc. This is a reference-grade codebase.
- Generate `icons/icon16.png`, `icon48.png`, `icon128.png` programmatically with a
  small Python script (`tools/gen_icons.py`, pure stdlib: struct+zlib PNG writer, draw
  a simple dark rounded square with a cyan grid glyph — 3 columns × 2 rows of lines).
  Run it. Do NOT leave placeholder/empty icons.
- If X's live layout requires any adjustment you discover while implementing, note it
  and adapt — but the fixture + smoke test is the proof of correctness for this build;
  do not attempt to log into x.com.

## 8. Execution instructions

1. Write all files listed in Deliverables.
2. Run `node --check` on every .js file; run `python3 -m json.tool manifest.json`.
3. Run `python3 tools/gen_icons.py` and confirm the three PNGs exist and are valid
   (file command or PIL-free size check).
4. Run the smoke test: `cd /home/lenovo/x-dashboard-grid && python3 test/smoke_test.py`
   — ALL 7 checks must pass. If a check fails, fix the extension code and re-run until
   green. This is part of the deliverable, not optional.
5. Update RESEARCH.md and README.md with anything you learned during implementation.
6. Report back: files created, smoke test results (list each of the 7 checks and
   PASS/FAIL), design decisions, and any risks found.