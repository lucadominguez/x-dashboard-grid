#!/usr/bin/env python3
"""Measure how much GridX actually costs on a churning feed.

Runs the SAME page twice - GridX active, then GridX switched off - so the
numbers isolate the extension's own overhead rather than the page's. Reports
long tasks, dropped frames during a scripted scroll, keypress latency, and
per-function time inside the content script.

Usage: perf_test.py <ext_dir> <url>
"""
import glob
import json
import os
import statistics
import sys

from playwright.sync_api import sync_playwright

EXT = os.path.abspath(sys.argv[1])
URL = sys.argv[2]
SETTLE_MS = 9000


def find_chrome():
    for pat in ("/tmp/pw-browsers/chromium-*/chrome-linux/chrome",
                os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome")):
        h = sorted(glob.glob(pat))
        if h:
            return h[-1]
    return None


def measure(pg, label):
    """Churn for a fixed window, scroll, then read the counters."""
    pg.evaluate("() => { window.__perf.longTasks.length = 0; window.__perf.frames.length = 0; }")
    # steady-state churn with no interaction
    pg.wait_for_timeout(SETTLE_MS)
    idle = pg.evaluate("() => ({ lt: [...window.__perf.longTasks], fr: [...window.__perf.frames] })")

    # scripted scroll, the part a user feels most
    pg.evaluate("() => { window.__perf.frames.length = 0; window.__perf.longTasks.length = 0; }")
    c = pg.evaluate("""() => { const s = document.querySelector('.gx-stream') || document.querySelector('shreddit-feed');
        if (!s) return null; const r = s.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(Math.max(80, r.top + 250)) }; }""")
    if c:
        pg.mouse.move(c["x"], c["y"])
    for _ in range(14):
        pg.mouse.wheel(0, 1200)
        pg.wait_for_timeout(260)
    scroll = pg.evaluate("() => ({ lt: [...window.__perf.longTasks], fr: [...window.__perf.frames] })")

    # keypress responsiveness (j = move cursor)
    lat = []
    for _ in range(8):
        t = pg.evaluate("""() => new Promise(res => {
            const t0 = performance.now();
            document.dispatchEvent(new KeyboardEvent('keydown', {key:'j', bubbles:true, cancelable:true}));
            requestAnimationFrame(() => res(Math.round(performance.now() - t0)));
        })""")
        lat.append(t)
        pg.wait_for_timeout(120)

    def frames_stat(fr):
        fr = [f for f in fr if 0 < f < 2000]
        if not fr:
            return (0, 0, 0)
        long_frames = len([f for f in fr if f > 33])   # under 30fps
        return (round(statistics.median(fr), 1), max(fr), long_frames)

    im, imax, ilong = frames_stat(idle["fr"])
    sm, smax, slong = frames_stat(scroll["fr"])
    out = {
        "label": label,
        "idle_longtasks": len(idle["lt"]),
        "idle_longtask_ms": sum(idle["lt"]),
        "idle_worst_task_ms": max(idle["lt"]) if idle["lt"] else 0,
        "idle_median_frame_ms": im,
        "idle_worst_frame_ms": imax,
        "scroll_longtasks": len(scroll["lt"]),
        "scroll_longtask_ms": sum(scroll["lt"]),
        "scroll_worst_task_ms": max(scroll["lt"]) if scroll["lt"] else 0,
        "scroll_median_frame_ms": sm,
        "scroll_worst_frame_ms": smax,
        "scroll_janky_frames": slong,
        "keypress_median_ms": round(statistics.median(lat), 1),
        "keypress_worst_ms": max(lat),
    }
    prof = pg.evaluate("""() => { const a = document.documentElement.getAttribute('data-gxperf');
        try { return a ? JSON.parse(a) : null; } catch (e) { return null; } }""")
    if prof:
        out["content_script_profile"] = prof
    return out


def main():
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            "/tmp/gridx-perf-profile", headless=False, executable_path=find_chrome(),
            viewport={"width": 1680, "height": 1000},
            args=["--disable-extensions-except=" + EXT, "--load-extension=" + EXT,
                  "--no-sandbox", "--disable-dev-shm-usage"])
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
        # Let the feed grow to its cap FIRST: comparing a phase on 600 posts
        # against a phase on 2000 measures the fixture, not the extension.
        for _ in range(90):
            if pg.evaluate("() => window.__atCap && window.__atCap()"):
                break
            pg.wait_for_timeout(1000)
        posts = pg.evaluate("() => window.__postCount ? window.__postCount() : -1")
        print("# feed settled at %d posts" % posts, file=sys.stderr)
        pg.wait_for_timeout(3000)

        def toggle():
            pg.evaluate("() => document.dispatchEvent(new CustomEvent('gridx:command', {detail:'toggle-grid'}))")
            pg.wait_for_timeout(2500)
            return pg.evaluate("() => document.documentElement.classList.contains('gridx-active')")

        # Alternate ON/OFF twice each so any drift shows up instead of hiding.
        runs = []
        a1 = pg.evaluate("() => document.documentElement.classList.contains('gridx-active')")
        runs.append(measure(pg, "ON-1" if a1 else "OFF-1"))
        s2 = toggle(); runs.append(measure(pg, "ON-2" if s2 else "OFF-2"))
        s3 = toggle(); runs.append(measure(pg, "ON-3" if s3 else "OFF-3"))
        s4 = toggle(); runs.append(measure(pg, "ON-4" if s4 else "OFF-4"))
        for r in runs:
            r["posts"] = posts

        ctx.close()

    on_runs = [r for r in runs if r["label"].startswith("ON")]
    off_runs = [r for r in runs if r["label"].startswith("OFF")]
    def med(rs, k):
        v = [r.get(k, 0) for r in rs]
        return round(statistics.median(v), 1) if v else 0
    on = {k: med(on_runs, k) for k in on_runs[0] if isinstance(on_runs[0][k], (int, float))}
    off = {k: med(off_runs, k) for k in off_runs[0] if isinstance(off_runs[0][k], (int, float))}
    on["label"], off["label"] = "GridX ON (median of %d)" % len(on_runs), "GridX OFF (median of %d)" % len(off_runs)
    print(json.dumps(runs, indent=2))
    print("\n=== overhead attributable to GridX ===")
    for k in ("idle_longtask_ms", "idle_worst_task_ms", "scroll_longtask_ms",
              "scroll_worst_task_ms", "scroll_janky_frames", "scroll_median_frame_ms",
              "keypress_median_ms"):
        a, b = on.get(k, 0), off.get(k, 0)
        ratio = ("%.1fx" % (a / b)) if b else "n/a"
        print("  %-24s ON %-8s OFF %-8s  (%s)" % (k, a, b, ratio))
    return 0


if __name__ == "__main__":
    sys.exit(main())
