# GridX - High-Density Feed Dashboard

Turn **X (twitter.com)** and **Reddit** into a high-density, multi-column
**grid dashboard** for scanning dozens of posts at once. It **columnizes the
site's own feed in place** via CSS - it does **not** call any site API, read
cookies, write anything, or fetch anything the site wouldn't (see
[RESEARCH.md](./RESEARCH.md)).

## Supported sites

| Site | Feed container | Post element | Permalink from |
|---|---|---|---|
| X / twitter.com | timeline scroller | `article[data-testid="tweet"]` | `a[href*="/status/"]` |
| reddit.com | `shreddit-feed` | `shreddit-post`, `shreddit-ad-post` | `permalink` attribute |
| old.reddit.com | site table | `.thing.link` | `data-permalink` |

Everything site-specific lives in one `SITES` table at the top of
`src/content/content.js`: which element is a post, where its permalink comes
from, how to spot an ad, whether the feed or the document owns the scroll, and
which filler elements to ignore. Adding a site means adding one entry there -
the rest of GridX is site-agnostic.

Two differences that matter, both found by testing against the live sites:

- **Reddit scrolls the document; X scrolls the feed container.** GridX only
  takes over scrolling where the feed is the scroller. Locking `overflow` on
  Reddit freezes the page and strands its infinite-scroll sentinel.
- **Reddit puts an `<hr>` between every entry** (28 posts among 70 children),
  so separators are excluded from feed detection and hidden in the grid rather
  than each taking a cell.

**GridX is read-only and "assistive-view":** it never calls the X API, never
reads cookies, never writes (no auto-like/RT/follow), never auto-scrolls, and
never sends a request X itself wouldn't. It just hides X's chrome and re-flows
the posts you've already loaded into multiple columns.

> **Note on architecture (v0.2):** the original build "hoisted" `<article>`
> nodes out of X's timeline into a custom grid. Live testing on x.com exposed a
> problem with that approach: emptying the timeline makes X's infinite-scroll
> sentinel always visible, so X fired dozens of page-loads with no human
> cadence — producing **temporary rate-limits** and **overlapping icons** (from
> heavy overrides of X's internals). v0.2 **re-flows X's own container in
> place** with a CSS grid. X keeps ownership of layout, scroll, pagination,
> clicks and rendering, which fixes both those problems at the root. See
> `src/content/content.js` header comment and RESEARCH.md.

---

## Features

*   **1–8 adjustable columns** (default 3), full-bleed feed, one scrolling grid.
*   **Density modes** — `compact` (max info), `cozy`, `roomy`, tighten gutters
    and tweet text scale.
*   **Scan mode** (`s`) — jumps to 8 columns × compact × hides avatars/media/
    metrics at 0.9× font = maximum information transfer.
*   **Font scale** 0.8×–1.4× applied to the feed.
*   **Click a post → opens the real post in a new tab** (native X permalink).
    Links, buttons and media controls keep working normally.
*   **Filters:** typeahead keyword bar (Enter applies, Esc clears). Terms hide
    matching posts; `-term` keeps only posts containing that term; handle
    include/exclude via stored settings.
*   **Vim-flavored keyboard nav** (list below).
*   **Stats:** rendered posts, hidden count, active time, column count — in the
    popup and a small status bar on the grid.
*   **Presets:** column presets and filter presets from Options.
*   **Extra CSS** hook for power users.

## Install (Chrome)

1.  Save / unpack this folder anywhere.
2.  Open `chrome://extensions`.
3.  Toggle **Developer mode** (top-right).
4.  Click **Load unpacked** and select the folder **containing `manifest.json`**
    (not the `src/` subfolder).
5.  Visit `https://x.com` (or `twitter.com`) while logged in.

> For an installable `.crx`/store build, zip the folder contents and upload to
> the Chrome Web Store.

## Tests

```bash
# fixtures (deterministic, no network)
cd test && python3 -m http.server 8731 &
python3 test/live_test.py <ext_dir> http://localhost:8731/fixture.html         x
python3 test/live_test.py <ext_dir> http://localhost:8731/fixture_reddit.html  reddit

# the original 7-check smoke test
python3 test/smoke_test.py
```

`live_test.py` loads the unpacked extension into headful Chromium and drives
the page the way a person would: land on the feed, scroll, click a post,
navigate with the keyboard, filter, hide ads, change columns, toggle scan mode,
and switch GridX off again. It also runs against the real sites by passing a
live URL instead of a fixture.

## Keyboard map

| Key | Action |
|---|---|
| `j` / `k` · `↓` / `↑` | next / previous post |
| `g` / `G` | top / bottom |
| `d` / `u` | half page down / up |
| `Space` / `Shift+Space` | page down / up |
| `Enter` | open post in a **new tab** |
| `o` | open post in the **same tab** |
| `Backspace` | go back |
| `f` | focus filter bar |
| `s` | toggle scan mode |
| `p` | pause / resume grid |
| `?` | show / hide keymap overlay |
| `Esc` | close overlay / clear cursor |
| **Click a post** | open the real post in a **new tab** |

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
    load/delete. Column presets capture columns/density/font/bleed; filter
    presets capture keyword+handle filters.
*   **Keyboard map:** read-only reference (v0.x).
*   **Extra CSS:** textarea appended to the grid's styles at runtime (**Apply**),
    plus **Reset to defaults**.

## Troubleshooting

*   **"GridX: timeline not found"** — GridX couldn't detect the container whose
    children are the tweets. Usually means (a) you're not on a timeline page, or
    (b) X shipped markup changes. Reload the page; if it persists, the layered
    selector logic in `src/content/content.js` (`isStreamHost`/`findHost`) may
    need updating. GridX never breaks X: it just shows the overlay and stays off.
*   **Grid shows one column** — the stream container or X's layout isn't being
    re-flowed (X markup drift). Columns are set inline on the detected
    `[data-gx-stream]` container.
*   **Previously rate-limited in v0.1** — that was the *hoisting* behavior
    emptying the timeline and over-triggering X's sentinel. v0.2 keeps articles
    in place, so pagination follows your real scroll cadence. If you got a
    temporary block, it clears on its own; GridX itself never bulk-fetches.
*   **Icons/layout overlap in v0.1** — also fixed by v0.2: we no longer override
    X's per-article internals.
*   **How to completely reset** — Options → **Reset to defaults** (clears
    settings, keeps presets). To clear everything, remove the extension.

## Developer notes

*   **No build step, no bundler, no dependencies.** Vanilla JS (ES2022). All
    scripts pass `node --check`; `manifest.json` validates with
    `python3 -m json.tool`.
*   **Local test hook:** `content_scripts.matches` includes `http://localhost/*`
    and `http://127.0.0.1/*` **only** so the Playwright smoke test can exercise
    the extension against `test/fixture.html` (not needed on x.com).
*   **Smoke test:** `cd <repo> && python3 test/smoke_test.py` needs Playwright +
    a Chrome-for-Testing binary (auto-found under Playwright's cache or
    `/tmp/pw-browsers`) and a display (headful is required for
    `--load-extension`). It starts its own HTTP server on `127.0.0.1:8765` and
    asserts all 7 checks:
    1. `#gridx-root` overlay exists
    2. stream host found + ≥20 articles present
    3. default 3 CSS columns on the host
    4. `load more` grows the grid (MutationObserver)
    5. `gridx:update {columnCount:4}` → 4 columns
    6. keyword filter hides matching posts
    7. `scanMode:true` → `gridx-scan` on `<html>`
*   **Icons:** regenerate with `python3 tools/gen_icons.py` (pure stdlib PNG
    writer, no Pillow).

## Risk summary

GridX is a **browser-extension / assistive-view** project, not a scraper: zero
extra X-network calls, zero writes, zero cookie/token access, no auto-scroll, no
mass fetch, and it requires your own logged-in session. The honest risks are
**maintenance** (X changes its DOM; the container/`data-testid` selectors may
need updating) and the **ToS gray zone** shared by all assistive extensions — not
account banning, because GridX adds no requests and follows your real scroll
cadence. See **[RESEARCH.md](./RESEARCH.md)** for the full platform/ToS/account
risk analysis and the list of things GridX deliberately does not build.

## License

MIT. Reference / educational build produced from `BUILD_BRIEF.md`. Not
affiliated with or endorsed by X Corp.