# GridX — Platform / API Constraints & Risk Analysis

This document is the honest "acceptable account **and** platform risk" deliverable
for GridX. It states plainly what is safe, what is a gray zone, and what we
deliberately did **not** build.

TL;DR: GridX is a **browser-extension / assistive-view** implementation. It sends
**zero** network requests to X beyond what the official client already makes,
never reads cookies, never writes, never auto-scrolls, and has no API/developer
tokens. Its residual risk is maintenance (X's DOM changes), not account banning.

---

## 1. The X API landscape (2026)

**Free tier (Basic):** X's developer API free tier is effectively *write-only for
products and read-restricted*. Under current X API pricing:

*   **Free / Basic:** per-product writes (100 posts/24h as of the free tier for
    post/delete), with **no low-cost read access to a full chronological home
    timeline**. Read is capped and, on the cheapest plans, delivered as
    **sampled** streams (search results are ~0.1–3% of real volume). Long-form or
    chronological reads require higher (paid) tiers.
*   **Pro / Enterprise:** paid tiers that restore richer read quotas but cost real
    money monthly and are still governed by the developer agreement.
*   **Auth model:** the modern `x-api` (X API v2 read) flow is **OAuth 2.0 PKCE
    with user tokens + refresh**, requiring a registered developer app.

**Why GridX does NOT use the API:**

1.  A server-side secret/API key cannot ship inside a browser extension — the
    extension package is public by design (see §4, MV3 no-remote-code).
2.  The free tier cannot deliver GridX's stated goal: a full, chronological,
    high-density home timeline. Paid tiers cost money and still restrict it.
3.  The X developer agreement restricts products that *replicate the
    chronological home timeline*, which is exactly what a dashboard does —
    contracting around that with the API is precisely the thing ToS limits.
4.  There is simply no read path that gives the user their own timeline affordably.

**Rate-limit reality (as of 2026):** free/Basic read limits are low and sampled;
paid tiers scale but cost money; all API reads are still OAuth-guarded and
rate-limited per app+user. None of this applies to GridX because GridX makes no
API calls.

---

## 2. Web scraping / X ToS risk — why GridX is an "assistive view", not a scraper

X's **Terms of Service** and its **Automation / Developer Agreement** prohibit
scraping X without prior permission and prohibit circumventing X's own API.
GridX does not scrape under either definition:

*   **No network requests to X beyond the client's own.** GridX performs zero
    `fetch`/XHR to any X endpoint. Every byte it shows is a `<div>` X itself
    already downloaded and rendered in the user's logged-in session. It adds no
    request that a normal tab wouldn't make.
*   **No storage server-side.** There is no server, no backend, no outbound data.
*   **Re-rendering already-loaded DOM.** GridX hoists DOM nodes the browser has;
    it is a local presentation layer (a new stylesheet + a grid wrapper), not a
    data pipeline.
*   **Read-only, single-user, on the user's own session.** It requires the user's
    own authenticated `x.com` session and does not act as an agent.
*   **Zero writes / no automation / no auto-scroll / no mass fetch.** It never
    POSTs, never auto-likes/RTs/follows, never programmatically scrolls (which is
    also why it cannot be used to harvest scroll-loads).

**Category argument.** This is the same category as ad-blockers, dark-mode
toggles, i18n re-skins, and uBlock — well-established "assistive view" extensions
that manipulate the DOM a user already loaded, and that ship in the Chrome Web
Store. It is materially different from an off-site scraper that fetches X on
behalf of a server.

**Residual ToS posture.** Any DOM-manipulation extension sits in a ToS gray zone
because X's contractual documents are broad and change without notice. X can
change its markup or its ToS at any time. Two concrete mitigations keep GridX
"browser-extension / assistive-view" rather than "scraping": it never
programmatically navigates/scrolls, and it never captures data outside the live
page. **X's own official multi-column answer is TweetDeck (X Pro)**, which is paid
and lower-density; GridX's differentiator is **information density + free**,
not data extraction.

---

## 3. Account risk — enumerated surface

Surface the extension actually touches:

| Concern | GridX status |
|---|---|
| Writes (post/RT/like/follow) | none — read-only, no POST, no automation |
| Cookie / Auth token access | none — no `cookies` permission, no API tokens |
| Mass fetch / drain | none — no pagination scraping, no auto-scroll |
| Network fingerprint | identical to the official client — GridX adds no requests |
| Scroll cadence | normal human; GridX never synthetic-scrolls |
| Developer app / OAuth | not used — nothing to revoke |

**Residual risks (ranked):**

1.  **Real risk — X changes its DOM.** `data-testid` selectors and the primary
    column layout churn. This is a maintenance problem, not a ban risk. GridX
    handles it with layered selectors + a "timeline not found" overlay that
    never breaks the page (and restores the original DOM on toggle-off).
2.  **Mechanical/enterprise policy.** Corporate AV/proxies or enterprise policy
    may restrict any `--load-extension`/unpacked extension use. Out of scope.
3.  **ToS gray zone on DOM manipulation.** Present for ALL such extensions; biased
    low here because there is no scraping/automation. **It increases only if a
    user wires GridX into bots/automation** — which GridX itself does not provide.

**Mitigations implemented:** no tokens to leak; no cookies to read; read-only;
user's own session; no auto-scroll/auto-fetch; fail-safe overlay + full restore
on toggle-off (`html.gridx-active` class removed, articles re-parented back).

---

## 4. MV3 constraints

*   **No remote code.** All scripts ship with the package; nothing is fetched at
    runtime. CSP forbids inline scripts in `popup`/`options` pages — both use
    external `.js` files only.
*   **Service worker lifetime.** The background worker may be killed anytime; it
    holds **no state** — it only forwards a command relay and relies on
    `chrome.commands`. All state (grid settings, stats) lives in
    `chrome.storage.local`.
*   **Storage limits.** `chrome.storage.sync` is ~8KB per item (too small for
    `extraCss`); GridX uses **`chrome.storage.local`** (unlimited with `unlimitedStorage`
    opt-in, generous without) exactly as the brief requires.
*   **Content-script world.** GridX runs in the **isolated world**. That means
    our JS globals never collide with the page, but our CSS still matches cold
    DOM. Because grid styles target **our own wrapper classes** (`#gridx-root`,
    `.gx-cell`) and not X's classes, an X markup drift does not break our styling.
    Where X's own styles would override us we use `!important` and scope
    everything under `#gridx-root` (plus `html.gridx-active` page guards).
*   **Messaging w/o `tabs` permission.** Popup/options push settings to the
    active/grid tabs via `chrome.tabs.query` + `chrome.tabs.sendMessage`. Querying
    the *active* tab does not need `tabs`, and host access for `x.com` /
    `twitter.com` / `localhost` is implied by the content-script `matches`.
    `sendMessage` simply rejects on tabs without our content script (caught).
    This is why the manifest is able to stay at **permissions: ["storage"] only**.
*   **Smoke test hook.** `localhost`/`127.0.0.1` are in `content_scripts.matches`
    purely so the Playwright fixture test can run; it is a documented dev hook,
    not a user-facing feature.

---

## 5. Design consequence table

| Constraint | Chosen design | Residual risk |
|---|---|---|
| No server sidecar / MV3 no-remote-code | All logic is a content script; no build step | Larger content script to maintain |
| Packaged extension can't hold API secrets | No X API integration at all | Not a full "native" X client; depends on the web UI |
| `storage.sync` 8KB limit | `chrome.storage.local` + explicit `extraCss` | Setting changes hidden behind "Apply"/reload |
| Free tier can't stream home timeline | Read the user's live DOM instead | X DOM === maintenance burden |
| User's own session is the only auth | Require the user to be logged into x.com | Nothing to do when logged out |
| X houses the source of truth | Re-parent X's nodes; stash, never destroy | Needs MutationObserver discipline |
| X styles fight our grid | `#gridx-root`-scoped CSS + `!important` | Heavy `!important` can flag as fragile |
| JS in isolated world | Never touch X globals; style only our wrappers | — |
| Playwright fixture proxying | localhost/127.0.0.1 content-script match | Dev-only surface in the manifest |
| Must never break X | Fail-safe overlay + full restore on toggle-off | — |

---

## What GridX deliberately did NOT build

*   **Auto-scroll / infinite-scroll bots** — prohibited by our risk posture and ToS.
*   **X API integration** (any tier) — can't ship secrets, can't beat the timeline ToS.
*   **Multi-account** — requires unencrypted credential handling; out of scope.
*   **Posting automation** (auto-like/RT/follow/comment) — read-only by design.
*   **Mass export / capture** of timelines — no scraping.
*   **Data persistence of tweet contents** — only size-limited usage counters are
    persisted, and only locally.

*Generated 2026-08-09 as part of the GridX build. Facts about X API tiers and
ToS should be re-validated against docs.x.com before publication.*