#!/usr/bin/env python3
"""GridX reliability soak: does it survive real usage over time?

Functional tests prove it works once. This proves it keeps working - through
container replacement (SPA navigation), repeated toggling, filter churn, and a
long run - and that it does not leak.

Usage: soak_test.py <ext_dir> <url> [minutes]
"""
import glob
import os
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

EXT = os.path.abspath(sys.argv[1])
URL = sys.argv[2]
MINUTES = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ((" :: " + str(detail)[:200]) if detail else ""))
    return ok


def find_chrome():
    for pat in ("/tmp/pw-browsers/chromium-*/chrome-linux/chrome",
                os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome")):
        h = sorted(glob.glob(pat))
        if h:
            return h[-1]
    return None


GRID_OK = """() => {
  const s = document.querySelector('.gx-stream');
  if (!s) return { ok:false, why:'no .gx-stream' };
  const cs = getComputedStyle(s);
  const cols = cs.gridTemplateColumns ? cs.gridTemplateColumns.split(' ').length : 0;
  const posts = s.querySelectorAll('shreddit-post, article, .thing.link').length;
  const tagged = [...s.querySelectorAll('shreddit-post, .thing.link, article[data-testid="tweet"]')]
                   .filter(p => p.dataset && p.dataset.gxUrl).length;
  return { ok: cs.display === 'grid' && cols >= 1, display: cs.display, cols, posts, tagged };
}"""


def heap(pg):
    return pg.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize : 0")


def main():
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            "/tmp/gridx-soak", headless=False, executable_path=find_chrome(),
            viewport={"width": 1680, "height": 1000},
            args=["--disable-extensions-except=" + EXT, "--load-extension=" + EXT,
                  "--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"])
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
        pg.wait_for_timeout(6000)
        check("grid up at start", pg.evaluate(GRID_OK)["ok"], pg.evaluate(GRID_OK))

        # --- 1. feed container replaced, the way an SPA navigation does it ----
        # The observer is bound to the old node; a detached node never fires
        # again, so only the watchdog can recover this.
        pg.evaluate("""() => {
          const old = document.querySelector('shreddit-feed');
          const fresh = document.createElement('shreddit-feed');
          for (let i = 0; i < 12; i++) {
            const art = document.createElement('article');
            const p = document.createElement('shreddit-post');
            p.setAttribute('permalink', '/r/rebuilt/comments/' + (5000+i) + '/replaced_' + i + '/');
            p.setAttribute('post-title', 'replaced feed post ' + i);
            p.innerHTML = '<div class="pt">replaced feed post ' + i + '</div>';
            art.appendChild(p); fresh.appendChild(art);
            fresh.appendChild(document.createElement('hr'));
          }
          old.replaceWith(fresh);
        }""")
        pg.wait_for_timeout(5000)
        st = pg.evaluate(GRID_OK)
        check("recovers after the feed container is replaced", st["ok"], st)
        check("re-tags posts in the replaced feed", st.get("tagged", 0) > 0, st)

        # --- 2. toggle off/on repeatedly --------------------------------------
        for i in range(6):
            pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:command',{detail:'toggle-grid'}))")
            pg.wait_for_timeout(700)
        pg.wait_for_timeout(2500)
        st = pg.evaluate(GRID_OK)
        check("survives 6 on/off toggles", st["ok"], st)

        # --- 3. filter churn ---------------------------------------------------
        for term in ["replaced", "kubernetes", "zzzznomatch", ""]:
            pg.evaluate("(t) => document.dispatchEvent(new CustomEvent('gridx:update',{detail:{filterKeywords: t ? [t] : []}}))", term)
            pg.wait_for_timeout(600)
        vis = pg.evaluate("() => [...document.querySelectorAll('.gx-stream > *')].filter(e=>getComputedStyle(e).display!=='none').length")
        check("filters clear back to a full feed", vis > 0, "visible=%d" % vis)

        # --- 4. long run under churn, watching the heap ------------------------
        pg.evaluate("() => { if (window.gc) window.gc(); }")
        pg.wait_for_timeout(1500)
        h0 = heap(pg)
        deadline = time.time() + MINUTES * 60
        samples, integrity_fails = [], 0
        while time.time() < deadline:
            pg.mouse.move(800, 500)
            pg.mouse.wheel(0, 1600)
            pg.wait_for_timeout(700)
            if int(time.time()) % 5 == 0:
                s = pg.evaluate(GRID_OK)
                if not s["ok"]:
                    integrity_fails += 1
                samples.append(heap(pg))
        h1 = heap(pg)
        growth_mb = round((h1 - h0) / 1048576.0, 1)
        print("   heap %0.1fMB -> %0.1fMB over %.1f min" % (h0/1048576.0, h1/1048576.0, MINUTES))
        check("grid stayed intact for the whole run", integrity_fails == 0, "%d bad samples of %d" % (integrity_fails, len(samples)))
        check("no runaway heap growth (<40MB)", growth_mb < 40, "%+0.1fMB" % growth_mb)

        st = pg.evaluate(GRID_OK)
        check("grid still correct at the end", st["ok"], st)

        ours = [e for e in errors if "gridx" in e.lower()]
        check("no GridX console errors across the soak", not ours, ours[:3])

        ctx.close()

    bad = [r for r in results if not r[1]]
    print("\n--- soak summary ---")
    print("%d/%d checks passed" % (len(results) - len(bad), len(results)))
    for n, _, d in bad:
        print("   FAILED: %s %s" % (n, d))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
