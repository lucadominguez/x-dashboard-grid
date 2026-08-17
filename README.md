# GridX - High-Density X Dashboard

Turn X (Twitter) into a high-density, multi-column **grid dashboard**. View dozens
of posts at once, navigate with vim-style keys, and scan feeds at maximum
information-transfer rate.

## Features

- **Adjustable columns (1-8)** - the grid re-flows live.
- **Density modes** - compact (max info), cozy, roomy.
- **Scan mode** (hotkey `s`) - jumps to 8 columns + compact density, hides
  avatars/media/metrics for absolute maximum information density. Toggle restores
  prior settings.
- **Keyboard navigation** - `j/k/h/l`, `g`/`G`, `x` expand, `Enter` open in new tab.
- **Filters** - keyword include/exclude, handle include/exclude.
- **Font scale** - 0.8x-1.4x.
- **Hide promoted / retweets / verified badges**.
- **Bounded memory** - the grid keeps the newest N posts (default 300, adjustable
  in Options) and drops older ones off the top, so a long scroll session cannot
  grow without limit.
- **Fully read-only** - no X API, no cookies, no writes, and no changes to X's own
  DOM. The extension reads the timeline you have already loaded and renders a
  separate CSS grid beside it. No scraping, no automation, no account risk.

## Install (dev / load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this `extension/` folder.

Or package it: zip the contents of `extension/` and upload to the Chrome Web Store.

## Keyboard map

| Key | Action |
|-----|--------|
| `j` / `↓` | Down one row |
| `k` / `↑` | Up one row |
| `h` / `←` | Left one post |
| `l` / `→` | Right one post |
| `g` / `G` | Top / bottom |
| `s` | Toggle scan mode |
| `x` | Expand current cell |
| `p` | Pause / resume |
| `f` | Focus filter |
| `Enter` / `o` | Open post in new tab |
| Click | Open post in new tab (ctrl-click and middle-click work too) |
| `Ctrl+Shift+G` | Global enable/disable |
| `Ctrl+Shift+P` | Global pause |

## Options

Popup gives quick controls (columns, density, scan, media, filters). The full
options page has presets, keyboard map, and extra CSS. All settings persist in
`chrome.storage.local`.

## Troubleshooting

- **Timeline not found** - X changed its markup. Reload the page. GridX uses
  layered selector fallbacks and shows a clear overlay instead of breaking X.
- **Grid doesn't apply** - reopen the popup and hit "Enable Grid".
- **Reset** - Options -> Reset to defaults, or clear `gridxSettings` from
  `chrome.storage.local`.

## Risk summary

GridX is an assistive, read-only view. It makes zero network requests beyond what
the official X client already makes, stores nothing server-side, never calls the
X API, never touches cookies, and requires your own authenticated session. See
`RESEARCH.md` for the full platform/API constraint and risk analysis.
