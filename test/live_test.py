#!/usr/bin/env python3
"""GridX live end-to-end test: drive a REAL site with the extension loaded.

Not a fixture test. This loads the unpacked extension into headful Chromium and
uses the site the way a person would: land on the feed, look at it, scroll,
click a post, use the keyboard, filter, toggle scan mode. Every check reports
PASS/FAIL and the script exits non-zero if anything fails.

Usage: live_test.py <ext_dir> <url> [site_id]
"""
import glob
import os
import sys
import time

from playwright.sync_api import sync_playwright

EXT = os.path.abspath(sys.argv[1])
URL = sys.argv[2]
SITE = sys.argv[3] if len(sys.argv) > 3 else "reddit"

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ((" :: " + str(detail)[:220]) if detail else ""))
    return ok


def find_chrome():
    for pat in ("/tmp/pw-browsers/chromium-*/chrome-linux/chrome",
                os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome")):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    return None


def main():
    chrome = find_chrome()
    profile = "/tmp/gridx-live-profile-" + SITE
    os.system("rm -rf " + profile)
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=False,
            executable_path=chrome,
            viewport={"width": 1680, "height": 1000},
            args=[
                "--disable-extensions-except=" + EXT,
                "--load-extension=" + EXT,
                "--no-sandbox", "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        print("\n=== %s : %s ===" % (SITE.upper(), URL))
        pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
        try:
            pg.wait_for_selector("shreddit-post, article, .thing.link", timeout=40000)
        except Exception:
            pass
        pg.wait_for_timeout(4000)  # let GridX boot and apply

        # ---- 1. did GridX activate at all? -----------------------------
        st = pg.evaluate("""() => {
          const h = document.documentElement;
          const s = document.querySelector('.gx-stream');
          const cs = s ? getComputedStyle(s) : null;
          return {
            active: h.classList.contains('gridx-active'),
            hasStream: !!s,
            streamTag: s ? s.tagName.toLowerCase() : null,
            display: cs ? cs.display : null,
            cols: cs ? cs.gridTemplateColumns : null,
            colCount: cs && cs.gridTemplateColumns ? cs.gridTemplateColumns.split(' ').length : 0,
            overlay: !!document.getElementById('gridx-root'),
            fatalShown: (() => { const f=document.getElementById('gridx-fatal'); return !!f && !f.hidden; })(),
          };
        }""")
        print("   state:", st)
        check("GridX activated", st["active"])
        check("feed container found", st["hasStream"], st["streamTag"])
        check("no 'feed not found' error shown", not st["fatalShown"])
        check("feed is display:grid", st["display"] == "grid", st["display"])
        check("grid has 3 columns", st["colCount"] == 3, st["cols"])

        # ---- 2. are posts actually laid out side by side? ---------------
        lay = pg.evaluate("""() => {
          const s = document.querySelector('.gx-stream');
          if (!s) return null;
          const kids = [...s.children].filter(k => k.offsetParent !== null && k.getBoundingClientRect().height > 20);
          const xs = [...new Set(kids.slice(0, 12).map(k => Math.round(k.getBoundingClientRect().left)))];
          return { visibleCells: kids.length, distinctX: xs.length, xs: xs.slice(0,6),
                   docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2 };
        }""")
        print("   layout:", lay)
        check("posts occupy >=3 distinct columns", lay and lay["distinctX"] >= 3, lay)
        check("no horizontal page overflow", lay and not lay["docOverflow"])

        # ---- 3. separators/ads do not eat cells -------------------------
        sep = pg.evaluate("""() => {
          const s = document.querySelector('.gx-stream');
          if (!s) return null;
          const hrs = [...s.querySelectorAll(':scope > hr')];
          const visibleHr = hrs.filter(h => getComputedStyle(h).display !== 'none').length;
          return { hrTotal: hrs.length, visibleHr };
        }""")
        print("   separators:", sep)
        if sep and sep["hrTotal"]:
            check("separators hidden (not occupying cells)", sep["visibleHr"] == 0, sep)

        # ---- 4. permalinks tagged -------------------------------------
        marks = pg.evaluate("""() => {
          const posts = [...document.querySelectorAll('shreddit-post, .thing.link, article[data-testid=\\"tweet\\"]')];
          const tagged = posts.filter(p => p.dataset && p.dataset.gxUrl);
          return { posts: posts.length, tagged: tagged.length,
                   sample: tagged.slice(0,2).map(p => p.dataset.gxUrl) };
        }""")
        print("   permalinks:", marks)
        check("posts tagged with permalinks", marks["posts"] > 0 and marks["tagged"] >= marks["posts"] * 0.8, marks)
        check("permalink looks real", bool(marks["sample"]) and "/comments/" in (marks["sample"][0] or "") if SITE == "reddit" else True, marks.get("sample"))

        # ---- 5. scroll like a person; does more load, does it stay smooth?
        before = pg.evaluate("() => document.querySelectorAll('shreddit-post, article, .thing.link').length")
        # Put the pointer over the feed first: where the feed container is the
        # scroller (X), a wheel event at (0,0) scrolls nothing.
        cpt = pg.evaluate("""() => { const s=document.querySelector('.gx-stream');
          if(!s) return null; const r=s.getBoundingClientRect();
          return { x: Math.round(r.left + r.width/2), y: Math.round(Math.max(80, r.top + 200)) }; }""")
        if cpt: pg.mouse.move(cpt["x"], cpt["y"])
        t0 = time.time()
        for _ in range(12):
            pg.mouse.wheel(0, 1400)
            pg.wait_for_timeout(500)
        scroll_ms = int((time.time() - t0) * 1000)
        pg.wait_for_timeout(2500)
        after = pg.evaluate("() => document.querySelectorAll('shreddit-post, article, .thing.link').length")
        still = pg.evaluate("""() => {
          const s = document.querySelector('.gx-stream');
          const cs = s ? getComputedStyle(s) : null;
          return { grid: cs ? cs.display : null,
                   cols: cs && cs.gridTemplateColumns ? cs.gridTemplateColumns.split(' ').length : 0,
                   scrolled: Math.max(window.scrollY || 0, s ? s.scrollTop : 0),
                   // Range of whichever element actually owns the scroll:
                   // with the feed as scroller the document cannot move at all.
                   maxScroll: (s && getComputedStyle(s).overflowY === 'auto')
                     ? (s.scrollHeight - s.clientHeight)
                     : (document.documentElement.scrollHeight - innerHeight),
                   loadMore: !!document.querySelector('#load-more, [data-load-more]') };
        }""")
        print("   scroll: posts %d -> %d in %dms; %s" % (before, after, scroll_ms, still))
        if after == before and still.get("loadMore"):
            # Static fixture with an explicit pager: click it the way a user would.
            pg.click("#load-more, [data-load-more]")
            pg.wait_for_timeout(1800)
            after = pg.evaluate("() => document.querySelectorAll('shreddit-post, article, .thing.link').length")
        check("more posts load on demand", after > before, "%d -> %d" % (before, after))
        # Assert we reached the end of whatever scroll range exists: a short
        # fixture legitimately has only a few dozen pixels of travel.
        want = min(200, max(0, still["maxScroll"] - 5))
        check("scrolling moves the feed to its end", still["scrolled"] >= want, still)
        check("grid survives scrolling", still["grid"] == "grid" and still["cols"] == 3, still)

        # ---- 6. click a post opens the real permalink -------------------
        opened = {}
        def on_page(p):
            opened["url"] = p.url
        ctx.on("page", on_page)
        clicked = pg.evaluate("""() => {
          // Must be a post currently ON SCREEN: after scrolling, the first
          // tagged post is far above the viewport.
          const all = [...document.querySelectorAll('shreddit-post[data-gx-url], .thing.link[data-gx-url], article[data-gx-url]')];
          for (const p of all) {
            const r = p.getBoundingClientRect();
            if (r.top > 60 && r.bottom < innerHeight - 20 && r.width > 40 && r.height > 40) {
              return { url: p.dataset.gxUrl, x: Math.round(r.left + r.width - 10), y: Math.round(r.bottom - 6) };
            }
          }
          return null;
        }""")
        if clicked:
            pg.mouse.click(clicked["x"], clicked["y"])
            pg.wait_for_timeout(3000)
            got = opened.get("url", "") or pg.url
            ok = clicked["url"].split("?")[0].rstrip("/") in got.rstrip("/") or "/comments/" in got
            check("clicking a post opens its permalink", ok, "want=%s got=%s" % (clicked["url"], got))
            for extra in ctx.pages[1:]:
                try: extra.close()
                except Exception: pass
        else:
            check("clicking a post opens its permalink", False, "no clickable post found on screen")

        # Reddit post cards are native anchors, so the click may have navigated
        # this tab. Get back to the feed before the remaining checks.
        if not pg.url.rstrip('/').endswith(URL.rstrip('/').split('//')[-1].split('/',1)[0]) or '/comments/' in pg.url:
            pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
            try: pg.wait_for_selector("shreddit-post, article, .thing.link", timeout=40000)
            except Exception: pass
            pg.wait_for_timeout(4000)
        check("back on the feed for remaining checks", '/comments/' not in pg.url, pg.url)

        # ---- 7. keyboard navigation ------------------------------------
        pg.bring_to_front()
        pg.keyboard.press("Escape")
        pg.keyboard.press("j"); pg.wait_for_timeout(350)
        c1 = pg.evaluate("() => { const c=document.querySelector('.gx-cursor'); return c ? c.tagName.toLowerCase() : null; }")
        pg.keyboard.press("j"); pg.wait_for_timeout(350)
        c2 = pg.evaluate("""() => {
          const c = document.querySelector('.gx-cursor');
          const all = [...document.querySelectorAll('.gx-cursor')];
          return { tag: c ? c.tagName.toLowerCase() : null, count: all.length };
        }""")
        check("'j' sets a cursor on a post", bool(c1), c1)
        check("exactly one cursor element", c2["count"] == 1, c2)

        # ---- 8. filter hides posts -------------------------------------
        vis_before = pg.evaluate("() => [...document.querySelectorAll('.gx-stream > *')].filter(e=>getComputedStyle(e).display!=='none').length")
        term = pg.evaluate("""() => {
          const p = document.querySelector('shreddit-post');
          const t = p ? (p.getAttribute('post-title') || p.innerText || '') : '';
          const w = t.split(/\\s+/).filter(x => x.length > 4);
          return w.length ? w[0].toLowerCase() : null;
        }""")
        if term:
            pg.evaluate("(t) => document.dispatchEvent(new CustomEvent('gridx:update', {detail:{filterKeywords:[t]}}))", term)
            pg.wait_for_timeout(900)
            vis_after = pg.evaluate("() => [...document.querySelectorAll('.gx-stream > *')].filter(e=>getComputedStyle(e).display!=='none').length")
            check("keyword filter hides posts", vis_after < vis_before, "term=%r %d -> %d" % (term, vis_before, vis_after))
            pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:update', {detail:{filterKeywords:[]}}))")
            pg.wait_for_timeout(700)
            restored = pg.evaluate("() => [...document.querySelectorAll('.gx-stream > *')].filter(e=>getComputedStyle(e).display!=='none').length")
            check("clearing the filter restores posts", restored >= vis_before * 0.9, "%d -> %d" % (vis_after, restored))

        # ---- 8b. promoted/ad filtering ---------------------------------
        ads = pg.evaluate("() => document.querySelectorAll('shreddit-ad-post, [data-promoted=\"true\"]').length")
        if ads:
            pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:update', {detail:{hidePromoted:true}}))")
            pg.wait_for_timeout(900)
            shown = pg.evaluate("""() => [...document.querySelectorAll('shreddit-ad-post, [data-promoted=\"true\"]')]
                .filter(a => { const c = a.closest('article') || a; return getComputedStyle(c).display !== 'none'
                                 && getComputedStyle(a).display !== 'none'; }).length""")
            check("hidePromoted hides sponsored posts", shown == 0, "%d ads, %d still visible" % (ads, shown))
            pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:update', {detail:{hidePromoted:false}}))")
            pg.wait_for_timeout(600)

        # ---- 9. column change + scan mode -------------------------------
        pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:update', {detail:{columnCount:5}}))")
        pg.wait_for_timeout(800)
        c5 = pg.evaluate("() => { const s=document.querySelector('.gx-stream'); return s ? getComputedStyle(s).gridTemplateColumns.split(' ').length : -1; }")
        check("column count is settable (5)", c5 == 5, c5)
        pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:command', {detail:'toggle-scan'}))")
        pg.wait_for_timeout(800)
        sc = pg.evaluate("""() => { const s=document.querySelector('.gx-stream');
          return { scan: document.documentElement.classList.contains('gridx-scan'),
                   cols: s ? getComputedStyle(s).gridTemplateColumns.split(' ').length : -1 }; }""")
        check("scan mode widens to 8 columns", sc["scan"] and sc["cols"] == 8, sc)
        pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:command', {detail:'toggle-scan'}))")
        pg.wait_for_timeout(600)

        # ---- 10. toggle off restores the site ---------------------------
        pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:command', {detail:'toggle-grid'}))")
        pg.wait_for_timeout(900)
        off = pg.evaluate("""() => {
          const s = document.querySelector('[data-gx-stream]') || document.querySelector('shreddit-feed');
          const cs = s ? getComputedStyle(s) : null;
          return { active: document.documentElement.classList.contains('gridx-active'),
                   display: cs ? cs.display : null };
        }""")
        check("toggle-off deactivates GridX", not off["active"], off)
        check("feed returns to non-grid layout", off["display"] != "grid", off)

        # ---- 11. no console errors from us ------------------------------
        ours = [e for e in errors if "gridx" in e.lower()]
        check("no GridX console errors", not ours, ours[:3])
        print("   (site's own console errors, ignored: %d)" % (len(errors) - len(ours)))

        ctx.close()

    print("\n--- %s summary ---" % SITE)
    bad = [r for r in results if not r[1]]
    print("%d/%d checks passed" % (len(results) - len(bad), len(results)))
    for n, _, d in bad:
        print("   FAILED: %s %s" % (n, ("(" + str(d)[:160] + ")") if d else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
