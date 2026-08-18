#!/usr/bin/env python3
"""GridX against a REAL logged-in account, over CDP.

Connects to an already-running Chrome (--remote-debugging-port) that has the
user's own profile and session, so this exercises the real site: real markup,
real virtualization, real media, real infinite scroll.

STRICTLY READ-ONLY. This script never clicks a like, repost, bookmark, follow,
reply or share control, never submits anything, and never types into a
composer. It scrolls, reads the DOM, measures timings, and uses GridX's own
keyboard and messaging APIs. Before every click it asserts the target is not
inside an action row.

Usage: real_account_test.py <cdp_url> <site_url> [site_id]
"""
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

CDP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9222"
URL = sys.argv[2] if len(sys.argv) > 2 else "https://x.com/home"
SITE = sys.argv[3] if len(sys.argv) > 3 else "x"

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ((" :: " + str(detail)[:230]) if detail else ""))
    return ok


# Anything that would change account state. Never click inside one of these.
FORBIDDEN = ('[role="group"]', '[data-testid="like"]', '[data-testid="unlike"]',
             '[data-testid="retweet"]', '[data-testid="unretweet"]', '[data-testid="reply"]',
             '[data-testid="bookmark"]', '[data-testid="follow"]', '[data-testid="unfollow"]',
             'button', 'a', '[role="button"]', '[role="link"]', 'input', 'textarea',
             'shreddit-post-overflow-menu', 'faceplate-tracker[noun="upvote"]',
             'faceplate-tracker[noun="downvote"]', 'faceplate-tracker[noun="comments"]')


def main():
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.connect_over_cdp(CDP, timeout=20000)
        except Exception as e:
            print("Could not connect to Chrome at %s: %s" % (CDP, e))
            print("Start Chrome with Desktop\\gridx-debug-chrome.bat first.")
            return 2

        ctx = browser.contexts[0]
        pg = ctx.new_page()
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        print("\n=== REAL ACCOUNT: %s ===" % URL)
        pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
        try:
            pg.wait_for_selector('article[data-testid="tweet"], shreddit-post, article', timeout=45000)
        except Exception:
            pass
        pg.wait_for_timeout(6000)

        logged_in = pg.evaluate("""() => !!(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
            || document.querySelector('[data-testid="AppTabBar_Profile_Link"]')
            || document.querySelector('#email-collection-tooltip-id')
            || document.querySelector('shreddit-async-loader[bundlename="account_switcher"]'))""")
        check("logged in to a real session", logged_in, "if false, the grid is being tested logged-out")

        st = pg.evaluate("""() => {
          const s = document.querySelector('.gx-stream');
          const cs = s ? getComputedStyle(s) : null;
          return { active: document.documentElement.classList.contains('gridx-active'),
                   host: s ? s.tagName.toLowerCase() : null,
                   display: cs ? cs.display : null,
                   cols: cs && cs.gridTemplateColumns ? cs.gridTemplateColumns.split(' ').length : 0,
                   posts: document.querySelectorAll('article[data-testid="tweet"], shreddit-post, article').length,
                   fatal: (() => { const f=document.getElementById('gridx-fatal'); return !!f && !f.hidden; })() };
        }""")
        print("   state:", st)
        check("GridX activated on the real site", st["active"], st)
        check("found the real feed container", bool(st["host"]), st["host"])
        check("no 'feed not found' error", not st["fatal"])
        check("real feed is display:grid", st["display"] == "grid", st["display"])
        check("multi-column on the real feed", st["cols"] >= 2, st["cols"])

        lay = pg.evaluate("""() => {
          const s = document.querySelector('.gx-stream');
          if (!s) return null;
          const kids = [...s.children].filter(k => k.getBoundingClientRect().height > 20);
          const xs = [...new Set(kids.slice(0,12).map(k => Math.round(k.getBoundingClientRect().left)))];
          return { cells: kids.length, distinctX: xs.length,
                   overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2 };
        }""")
        check("real posts laid out in columns", lay and lay["distinctX"] >= 2, lay)
        check("no horizontal overflow on the real page", lay and not lay["overflow"], lay)

        tagged = pg.evaluate("""() => {
          const ps = [...document.querySelectorAll('article[data-testid="tweet"], shreddit-post')];
          const t = ps.filter(p => p.dataset && p.dataset.gxUrl);
          return { posts: ps.length, tagged: t.length, sample: t.slice(0,2).map(p => p.dataset.gxUrl) };
        }""")
        print("   permalinks:", tagged)
        check("real posts tagged with permalinks",
              tagged["posts"] > 0 and tagged["tagged"] >= tagged["posts"] * 0.8, tagged)

        # ---- performance on the REAL feed --------------------------------
        pg.evaluate("""() => {
          window.__rp = { lt: [], fr: [] };
          try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__rp.lt.push(Math.round(e.duration)); })
                  .observe({ entryTypes:['longtask'] }); } catch(e) {}
          let last = performance.now();
          (function f(t){ window.__rp.fr.push(Math.round(t-last)); last=t; requestAnimationFrame(f); })(performance.now());
        }""")
        c = pg.evaluate("""() => { const s=document.querySelector('.gx-stream');
            if(!s) return null; const r=s.getBoundingClientRect();
            return { x: Math.round(r.left + r.width/2), y: Math.round(Math.max(120, r.top + 250)) }; }""")
        if c:
            pg.mouse.move(c["x"], c["y"])
        before = pg.evaluate("() => document.querySelectorAll('article[data-testid=\"tweet\"], shreddit-post').length")
        t0 = time.time()
        for _ in range(15):
            pg.mouse.wheel(0, 1400)
            pg.wait_for_timeout(400)
        pg.wait_for_timeout(2500)
        after = pg.evaluate("() => document.querySelectorAll('article[data-testid=\"tweet\"], shreddit-post').length")
        perf = pg.evaluate("() => ({ lt: window.__rp.lt.slice(), fr: window.__rp.fr.slice() })")
        fr = [f for f in perf["fr"] if 0 < f < 2000]
        janky = len([f for f in fr if f > 33])
        print("   real scroll: posts %d -> %d, %d long tasks (%dms total), %d/%d janky frames"
              % (before, after, len(perf["lt"]), sum(perf["lt"]), janky, len(fr)))
        check("real infinite scroll keeps loading", after > before, "%d -> %d" % (before, after))
        check("scrolling the real feed stays smooth (<12% janky frames)",
              len(fr) > 0 and janky <= max(6, 0.12 * len(fr)), "%d janky of %d" % (janky, len(fr)))
        check("no long task over 200ms while scrolling",
              not perf["lt"] or max(perf["lt"]) <= 200, "worst=%sms" % (max(perf["lt"]) if perf["lt"] else 0))

        still = pg.evaluate("""() => { const s=document.querySelector('.gx-stream');
            const cs = s ? getComputedStyle(s) : null;
            return { display: cs?cs.display:null,
                     cols: cs&&cs.gridTemplateColumns?cs.gridTemplateColumns.split(' ').length:0 }; }""")
        check("grid survives real scrolling", still["display"] == "grid" and still["cols"] >= 2, still)

        # ---- keyboard on the real feed -----------------------------------
        lat = []
        for _ in range(6):
            t = pg.evaluate("""() => new Promise(res => { const t0=performance.now();
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true,cancelable:true}));
                requestAnimationFrame(()=>res(Math.round(performance.now()-t0))); })""")
            lat.append(t)
            pg.wait_for_timeout(150)
        cur = pg.evaluate("() => document.querySelectorAll('.gx-cursor').length")
        check("keyboard cursor works on the real feed", cur == 1, "cursors=%d" % cur)
        check("keypress latency under 16ms on the real feed",
              statistics.median(lat) < 16, "median=%sms all=%s" % (statistics.median(lat), lat))

        # ---- click-through, on a provably safe target ---------------------
        target = pg.evaluate("""(forbidden) => {
          const posts = [...document.querySelectorAll('article[data-gx-url], shreddit-post[data-gx-url]')];
          for (const p of posts) {
            const r = p.getBoundingClientRect();
            if (r.top < 120 || r.bottom > innerHeight - 40) continue;
            // Aim at the post's text, never the action row.
            const txt = p.querySelector('[data-testid="tweetText"], .pt, [slot="title"]');
            if (!txt) continue;
            const tr = txt.getBoundingClientRect();
            if (tr.height < 8 || tr.top < 120 || tr.bottom > innerHeight - 40) continue;
            const x = Math.round(tr.left + Math.min(40, tr.width/2));
            const y = Math.round(tr.top + tr.height/2);
            const el = document.elementFromPoint(x, y);
            if (!el) continue;
            // Refuse anything that could change account state.
            let bad = false;
            for (const sel of forbidden) { try { if (el.closest(sel)) { bad = true; break; } } catch(e){} }
            if (bad) continue;
            return { url: p.dataset.gxUrl, x, y, tag: el.tagName.toLowerCase() };
          }
          return null;
        }""", list(FORBIDDEN))
        if target:
            print("   click target:", target)
            opened = {}
            ctx.on("page", lambda p: opened.setdefault("url", p.url))
            pg.mouse.click(target["x"], target["y"])
            pg.wait_for_timeout(3500)
            got = opened.get("url", "") or pg.url
            ok = ("/status/" in got) or ("/comments/" in got)
            check("clicking a real post opens the real permalink", ok, "want=%s got=%s" % (target["url"], got))
            for extra in ctx.pages:
                if extra is not pg:
                    try: extra.close()
                    except Exception: pass
        else:
            check("clicking a real post opens the real permalink", False,
                  "no post text found clear of action controls; skipped rather than risk a like/repost")

        ours = [e for e in errors if "gridx" in e.lower()]
        check("no GridX console errors on the real site", not ours, ours[:3])
        print("   (site's own console errors, ignored: %d)" % (len(errors) - len(ours)))

        # leave the tab as we found it
        pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:command',{detail:'toggle-grid'}))")
        pg.wait_for_timeout(800)
        pg.close()

    bad = [r for r in results if not r[1]]
    print("\n--- real account summary ---")
    print("%d/%d checks passed" % (len(results) - len(bad), len(results)))
    for n, _, d in bad:
        print("   FAILED: %s %s" % (n, ("(" + str(d)[:170] + ")") if d else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
