# GridX — High-Density X Dashboard

Turn your logged-in X (twitter.com) tab into a high-density, multi-column
**grid dashboard** for scanning dozens of posts at once. It re-parents the DOM
X already rendered (no X API, no cookies, no writes — see
[RESEARCH.md](./RESEARCH.md) for the full risk analysis).

**GridX is read-only and "assistive-view":** it never calls the X API, never
reads cookies, never writes (no auto-like/RT/follow), never auto-scrolls, and
never fetches anything X wouldn't. It just hides X's chrome and re-arranges the
posts you've already loaded.

---

## Features

*   **1–8 adjustable columns** (default 3), full-bleed, one scrolling grid.
*   **Density modes** — `compact` (max info), `cozy`, `roomy`.
*   **Scan mode** (`s`) — jumps to 8 columns × compact × hides avatars/media/
    metrics × 0.9× font = absolute maximum information transfer.
*   **Font scale** 0.8×–1.4× on cells only.
*   **Per-cell intelligence:** AD badge for promoted posts, `↻ @user` repost
    marker, `[image]/[gif]/[video]` chips, quoted-post collapse, hover/click to
    expand a post in place, `content-visibility` off-screen skipping for fast
    scroll.
*   **Filters:** typeahead keyword bar at the top of the grid (Enter applies,
    Esc clears). Terms hide matching posts; `-term` keeps only posts with that
    term. Handle include/exclude via stored settings.
*   **Vim-flavored keyboard nav** (list below).
*   **Stats:** rendered posts, hidden count, active time, column count — in the
    popup and a small status bar on the grid.
*   **Presets:** save/load **column presets** and **filter presets** from Options.
*   **Extra CSS** hook for power users.

## Install (Chrome)

1.  Save / unpack this folder anywhere.
2.  Open `chrome://extensions`.
3.  Toggle **Developer mode** (top-right).
4.  Click **Load unpacked** and select the folder containing `manifest.json`.
5.  Visit `https://x.com` (or `twitter.com`) while logged in.

> Unpacked MV3 extensions can be loaded locally; for an installable `.crx`/store
> build, zip the folder contents and upload to the Chrome Web Store.

## Keyboard map

| Key | Action |
|---|---|
| `j` / `k` · `↓` / `↑` | next / previous post |
| `h` / `l` · `←` / `→` | previous / next column |
| `g` / `G` | top / bottom |
| `d` / `u` | half page down / up |
| `Space` / `Shift+Space` | page down / up |
| `Enter` | open post in a **new tab** |
| `o` | open post in the **same tab** |
| `Backspace` | go back |
| `x` | expand / collapse post text |
| `m` | toggle media on current post |
| `f` | focus filter bar |
| `s` | toggle scan mode |
| `p` | pause / resume grid |
| `?` | show / hide keymap overlay |
| `Esc` | close overlay / clear cursor |

Browser-level (MV3 `commands`):

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+G` / `Cmd+Shift+G` | toggle GridX grid on/off |
| `Ctrl+Shift+P` / `Cmd+Shift+P` | pause / resume grid |

Keys are ignored while you're typing in a text field.

## Popup

Use the toolbar icon for a compact panel: column slider (live), density
segmented control, toggles (Media, Metrics, Avatars, Filter promoted, Filter
reposts, Filter verified), a quick keyword filter box, **Scan mode** and
**Pause** buttons, live stats, and a link to Options. Every control writes
settings and pushes them to the active tab instantly.

## Options

Full-page editor (also reachable via popup → Options):

*   **Layout:** columns, density, font scale, bleed mode.
*   **Content:** show/hide media, metrics, avatars; filter promoted/reposts/verified.
*   **Column presets & filter presets:** save the current settings under a name,
    load/delete later. Column presets capture columns/density/font/bleed; filter
    presets capture keyword+handle filters.
*   **Keyboard map:** read-only reference (v0.1).
*   **Extra CSS:** textarea appended to the grid's styles at runtime (**Apply**),
    plus **Reset to defaults**.

## Troubleshooting

*   **"GridX: timeline not found"** — GridX couldn't find the primary column or
    tweet articles. Usually means (a) you're not on a timeline page, or (b) X
    shipped markup changes. Reload the page first; if it persists, the layered
    selectors in `src/content/content.js` (top of file) need updating — feel
    free to edit and reload the extension. GridX never breaks the page: it just
    shows the overlay and leaves X untouched.
*   **Grid does not activate / nothing happens** — make sure you're logged into
    x.com, then click the toolbar icon (it shows grid status). Toggle with
    `Ctrl+Shift+G`.
*   **Cells look broken / overlay everything** — GridX is a viewport takeover;
    if you prefer, add `gx-bleed` spacing tweaks via **Extra CSS**, or toggle the
    grid off with `Ctrl+Shift+G` to instantly return to the normal X DOM.
*   **Font/DPI too small** — raise **Font scale** in Options; switch density to
    `cozy`/`roomy`.
*   **How to completely reset** — Options → **Reset to defaults**. This clears
    settings (presets are kept); to clear presets too, remove the extension and
    re-add it, or delete the `gridxColumnPresets`/`gridxFilterPresets` keys from
    `chrome.storage.local` in the console.

## Developer notes

*   **No build step, no bundler, no dependencies.** Vanilla JS (ES2022), all
    scripts pass `node --check`, `manifest.json` validates with
    `python3 -m json.tool`.
*   **Local test hook:** `content_scripts.matches` includes `http://localhost/*`
    and `http://127.0.0.1/*` **only** so the Playwright smoke test can exercise
    the extension against `test/fixture.html`. This is not a security feature and
    is not needed on x.com.
*   **Smoke test:** `cd <repo> && python3 test/smoke_test.py` needs Playwright +
    a Chrome-for-Testing binary (it auto-finds Playwright's or `/tmp/pw-browsers`)
    and a display (headful is required for `--load-extension`). It starts its own
    HTTP server on `127.0.0.1:8765` and asserts all 7 checks:
    1. `#gridx-root` exists
    2. ≥20 articles hoisted
    3. default 3 CSS columns
    4. `load more` grows the grid (MutationObserver)
    5. `gridx:update {columnCount:4}` → 4 columns
    6. keyword filter hides matching posts
    7. `scanMode:true` → `gridx-scan` on `<html>`
*   **Icons:** regenerate with `python3 tools/gen_icons.py` (pure stdlib PNG
    writer, no Pillow).

## Risk summary

GridX is a **browser-extension / assistive-view** project, not a scraper: zero
X-network calls, zero writes, zero cookie/token access, no auto-scroll, no mass
fetch, and it requires your own logged-in session. The honest risk is
**maintenance** (X changes its DOM), handled with layered selectors and a
fail-safe overlay. See **[RESEARCH.md](./RESEARCH.md)** for the full
platform/ToS/account risk analysis and the list of things GridX deliberately
does not build.

## License

Reference / educational build produced from `BUILD_BRIEF.md`. Not affiliated
with or endorsed by X Corp.