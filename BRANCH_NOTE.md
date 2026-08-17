# What this branch is

`store-build-v0.1.1` is **not** part of `main`'s history. It is an orphan branch
holding the separate GridX codebase that was packaged for the Chrome Web Store,
preserved here so it lives in version control instead of only on a VPS.

## Why it is separate

Two unrelated GridX implementations exist:

| | `main` | this branch |
|---|---|---|
| Architecture | CSS re-flow of X's own timeline container | overlay grid built from copied post text |
| `content.js` | 708 lines (v0.2.0) | 278 lines (v0.1.x) |
| Origin | `f841b45` → `287b9f6` | written independently for the store submission |

`main`'s v0.2.0 commit (`287b9f6`, "re-flow X's timeline in place") was a deliberate
pivot away from moving/duplicating X's nodes, because hoisting caused three
real-world failures on live x.com: an infinite-scroll rate-limit storm, action-row
icon overlap, and posts that could not be clicked.

The store build in this branch was written on the hoisting model and shipped the
same three failures. It was submitted to the Chrome Web Store as v0.1.0
(item `gfhchcjdlmjklfbgcomgimkcacgndgpc`) before that was noticed.

## What v0.1.1 changed

v0.1.1 fixes the crash and the dead clicks *within* the overlay architecture:

- cells are real `<a href>` permalinks, so click / ctrl-click / middle-click work
- the grid keeps a bounded window of posts (default 300) instead of growing forever
- cursor moves are O(1) instead of sweeping every cell
- the MutationObserver is scoped to the timeline and batched through one `rAF`
- X's own DOM is never moved or annotated
- the dead Display settings (avatars, media, metrics, promoted, retweets, handles)
  actually take effect

Measured against v0.1.0 over 2,000 posts through a virtualizing timeline:

| | v0.1.0 | v0.1.1 |
|---|---|---|
| Cells retained | 2000 (unbounded) | 339 (capped) |
| Cells that are real links | 0 | 339 |
| ms per batch, first 50 → last 50 | 51 → 194 (3.8x slowdown) | 33 → 29 (flat) |

## Status

**Superseded.** `main` (v0.2.0) is the architecture to ship. This branch exists so
the work is recoverable, not because it should be released. Note that v0.1.1 also
added an auto-advance that nudges the page when you reach the end of the grid,
which risks recreating the rate-limit storm v0.2.0 was written to eliminate.

Neither build has been verified against live x.com.
