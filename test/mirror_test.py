#!/usr/bin/env python3
"""GridX mirror-mode test: the grid X actually gets.

fixture_x_virtualized.html models the two facts about x.com that broke the
grid and that no other test covers:

  * posts are NOT a uniform height (150-520px here), and
  * a post mounts as a SHELL - its avatar and photo are filled in ~140ms later.

The checks below are the ones that failed on the live account:

  1. the mirror overlay exists and collects posts as the reader scrolls
  2. no clone is left picture-less (the empty white boxes in the grid)
  3. the columns stay balanced (round-robin packing left half-empty columns)
  4. scrolling does not blow the main thread up (the "slow, glitchy" report)

Usage: mirror_test.py            (finds the extension next to this file)
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke_test import find_chrome, start_server, wait_for, REPO, HOST, PORT  # noqa: E402

import tempfile  # noqa: E402

URL = 'http://%s:%d/fixture_x_virtualized.html?posts=400' % (HOST, PORT)

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('  [PASS] ' if ok else '  [FAIL] ') + name + ((' :: ' + str(detail)[:200]) if detail else ''))


def main():
    chrome = find_chrome()
    if not chrome:
        print('SKIP: Chrome for Testing binary not found.')
        return 0
    print('Using Chrome for Testing: %s' % chrome)
    server = start_server()
    user_data = tempfile.mkdtemp(prefix='gridx-mirror-')
    browser = None
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data,
                headless=False,
                executable_path=chrome,
                args=[
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-extensions-except=%s' % REPO,
                    '--load-extension=%s' % REPO,
                ],
                viewport={'width': 1440, 'height': 900},
            )
            page = browser.pages[0] if browser.pages else browser.new_page()
            page.goto(URL)
            page.wait_for_timeout(1500)

            check('0. running the build under test',
                  page.evaluate("document.documentElement.dataset.gridxBuild || ''") != '',
                  page.evaluate("document.documentElement.dataset.gridxBuild || 'NO BUILD STAMP'"))

            ok = wait_for(lambda: page.evaluate(
                "!!document.getElementById('gridx-mirror-inner')"), timeout=15)
            check('1a. mirror overlay is up', ok)

            page.evaluate("""window.__lt = [];
                try { new PerformanceObserver(l => {
                    for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
                }).observe({entryTypes:['longtask']}); } catch (e) {}""")

            # Real wheel input: X only feeds its virtualizer on trusted events,
            # and so does the fixture's.
            for _ in range(55):
                page.mouse.move(500, 500)
                page.mouse.wheel(0, 900)
                page.wait_for_timeout(160)
            page.wait_for_timeout(1500)

            clones = page.evaluate("document.querySelectorAll('.gx-mirror-cell').length")
            check('1b. grid collects posts while scrolling (>=25)', clones >= 25, 'clones=%d' % clones)

            blank = page.evaluate(
                "[...document.querySelectorAll('.gx-mirror-cell')]"
                ".filter(c => c.querySelectorAll('img').length === 0).length")
            check('2. every clone kept its pictures', blank == 0,
                  '%d of %d clones have no <img>' % (blank, clones))

            # A clone taken mid-render must catch up with its source, or the
            # cell shows a line and a half of a post and an action row.
            truncated = page.evaluate(
                "(() => {"
                " const byKey = new Map();"
                " for (const c of document.querySelectorAll('.gx-mirror-cell'))"
                "  byKey.set(c.dataset.gxUrl || '', c.textContent.length);"
                " let worst = 0;"
                " for (const cell of document.querySelectorAll('[data-testid=\"cellInnerDiv\"]')) {"
                "  const a = cell.querySelector('article'); if (!a) continue;"
                "  const l = a.querySelector('a[href*=\"/status/\"]'); if (!l) continue;"
                "  const mine = byKey.get(l.href); if (mine === undefined) continue;"
                "  const gap = a.textContent.length - mine;"
                "  if (gap > worst) worst = gap;"
                " } return worst; })()")
            check('2b. no clone is left behind its post', truncated <= 12,
                  'worst clone is %d characters short' % truncated)

            cols = page.evaluate("""(() => {
                const inner = document.getElementById('gridx-mirror-inner');
                const by = {};
                for (const c of inner.children) {
                    const col = c.style.gridColumnStart || '1';
                    by[col] = (by[col] || 0) + c.offsetHeight;
                }
                return by;
            })()""")
            heights = sorted(cols.values()) if cols else []
            spread = (heights[-1] - heights[0]) / heights[-1] if heights and heights[-1] else 1
            check('3. columns stay balanced (tallest within 25%% of shortest)',
                  len(heights) > 1 and spread <= 0.25,
                  'per-column px: %s, spread %.0f%%' % (cols, spread * 100))

            # Nothing may sit in a blank strip: if a cell's placement is
            # computed from a height the grid does not agree with - the zoom
            # trap, or a wrong intrinsic size under content-visibility - every
            # cell gets a gap under it.
            gaps = page.evaluate(
                "(() => {"
                " const byCol = new Map();"
                " for (const c of document.getElementById('gridx-mirror-inner').children) {"
                "  const col = c.style.gridColumnStart || '1';"
                "  const r = c.getBoundingClientRect();"
                "  if (!r.height) continue;"
                "  if (!byCol.has(col)) byCol.set(col, []);"
                "  byCol.get(col).push([r.top, r.bottom]);"
                " }"
                " let worst = 0;"
                " for (const rows of byCol.values()) {"
                "  rows.sort((a, b) => a[0] - b[0]);"
                "  for (let i = 1; i < rows.length; i++) {"
                "   const g = rows[i][0] - rows[i - 1][1];"
                "   if (g > worst) worst = Math.round(g);"
                "  }"
                " } return worst; })()")
            check('3c. no blank strips between cells', gaps <= 12,
                  'worst gap %dpx' % gaps)

            spill = page.evaluate("""(() => {
                let worst = 0;
                for (const c of document.querySelectorAll('.gx-mirror-cell')) {
                    const cw = c.getBoundingClientRect().width;
                    for (const im of c.querySelectorAll('img')) {
                        const w = im.getBoundingClientRect().width;
                        if (w - cw > worst) worst = Math.round(w - cw);
                    }
                }
                return worst;
            })()""")
            check('3b. pictures fit their column', spill <= 2,
                  'widest overflow %dpx' % spill)

            # A click anywhere on a mirrored post must open that post. Almost
            # every part of an X post is a role="link" / tabindex wrapper whose
            # handlers do not survive cloning, so this used to do nothing.
            opened = ''
            spot = page.evaluate(
                "(() => {"
                " const m = document.getElementById('gridx-mirror').getBoundingClientRect();"
                " for (const c of document.querySelectorAll('.gx-mirror-cell')) {"
                "  const r = c.getBoundingClientRect();"
                "  if (r.top >= m.top + 4 && r.bottom <= m.bottom - 4 && r.height > 40)"
                "   return {x: Math.round(r.left + r.width / 2),"
                "           y: Math.round(r.top + r.height / 2)};"
                " } return null; })()")
            try:
                if not spot:
                    raise RuntimeError('no cell fully inside the overlay')
                with browser.expect_page(timeout=5000) as popup:
                    page.mouse.click(spot['x'], spot['y'])
                opened = popup.value.url
                popup.value.close()
            except Exception as exc:
                opened = 'no tab opened (%s: %s)' % (type(exc).__name__, str(exc)[:90])
            check('5. clicking a post opens it', '/status/' in opened, opened)

            # A press on a copy's like button reaches the real post whenever
            # that post is still mounted underneath.
            liked = page.evaluate(
                "(() => {"
                " window.__likes = [];"
                " const m = document.getElementById('gridx-mirror').getBoundingClientRect();"
                " const live = new Set();"
                " for (const c of document.querySelectorAll('[data-testid=\"cellInnerDiv\"]')) {"
                "  const l = c.querySelector('a[href*=\"/status/\"]');"
                "  if (l) live.add(l.href);"
                " }"
                " for (const c of document.querySelectorAll('.gx-mirror-cell')) {"
                "  if (!live.has(c.dataset.gxUrl)) continue;"
                "  const r = c.getBoundingClientRect();"
                "  if (r.top < m.top || r.bottom > m.bottom) continue;"
                "  const b = c.querySelector('[data-testid=\"like\"]');"
                "  if (!b) continue;"
                "  const before = b.textContent;"
                "  b.click();"
                "  return {clicked: true, before: before, landed: window.__likes.length};"
                " } return {clicked: false}; })()")
            check('5b. a like on a copy reaches the real post',
                  bool(liked.get('clicked')) and liked.get('landed', 0) > 0,
                  str(liked))

            # Following a link inside the grid IN PLACE threw the collection
            # away: X rebuilds its timeline from the top and the mirror starts
            # over with it, so the reader came back to a feed they had never
            # seen. Links from inside the grid open a tab of their own.
            was = page.url
            stayed = ''
            try:
                with browser.expect_page(timeout=5000) as popup:
                    page.evaluate(
                        "document.querySelector('.gx-mirror-cell a[href]').click()")
                stayed = popup.value.url
                popup.value.close()
            except Exception as exc:
                stayed = 'no tab opened (%s)' % type(exc).__name__
            page.wait_for_timeout(300)
            check('5c. a link in the grid keeps the feed tab',
                  page.url == was and stayed.startswith('http'),
                  'feed still at %s, link opened %s' % (page.url.split('/')[-1], stayed))

            # Asking for more columns than the comfortable width allows used to
            # be capped in silence; a narrow column is scaled now instead.
            page.evaluate(
                "document.dispatchEvent(new CustomEvent('gridx:update',"
                "{detail:{columnCount:7}}))")
            page.wait_for_timeout(1500)
            wide = page.evaluate(
                "(() => {"
                " const inner = document.getElementById('gridx-mirror-inner');"
                " const used = new Set();"
                " for (const c of inner.children) used.add(c.style.gridColumnStart);"
                " return {tracks: getComputedStyle(inner).gridTemplateColumns.split(' ').length,"
                "         used: used.size,"
                "         zoom: getComputedStyle(inner.children[0]).zoom};"
                "})()")
            check('6. seven columns means seven columns',
                  wide['tracks'] == 7 and wide['used'] == 7, str(wide))

            # Every re-take is a whole post inserted and laid out again -
            # 3.4ms each, measured on the live feed. Catching up must not mean
            # re-cloning the same post four times while the reader scrolls.
            takes = page.evaluate(
                "(() => {"
                " let n = 0, extra = 0;"
                " for (const c of document.querySelectorAll('.gx-mirror-cell')) {"
                "  n++; extra += (+c.dataset.gxTakes || 1) - 1;"
                " } return {cells: n, extra: extra}; })()")
            per = takes['extra'] / max(1, takes['cells'])
            check('7. a post is not re-cloned over and over', per <= 1.2,
                  '%d extra takes over %d posts (%.2f each)'
                  % (takes['extra'], takes['cells'], per))

            lt = page.evaluate("window.__lt || []")
            worst = max(lt) if lt else 0
            total = sum(lt)
            check('4. scrolling stays responsive (no task > 200ms)', worst <= 200,
                  'long tasks: %d, worst %dms, total %dms' % (len(lt), worst, total))
            # The reading log: attention has to be counted for the posts
            # that were actually on screen, and the click has to be recorded
            # against the post that was clicked.
            page.wait_for_timeout(6000)   # let a flush land
            # chrome.storage is not reachable from the page's own world, so
            # the log is read where it lives: the extension's service worker.
            sw = (browser.service_workers[0] if browser.service_workers
                  else browser.wait_for_event('serviceworker'))
            log = sw.evaluate(
                "(async () => {"
                " const store = await chrome.storage.local.get('gridxActivity');"
                " const posts = (store.gridxActivity || {}).posts || {};"
                " const all = Object.values(posts);"
                " return {"
                "  n: all.length,"
                "  withDwell: all.filter(r => r.dwellMs > 0).length,"
                "  opened: all.filter(r => r.opens > 0).length,"
                "  authors: all.filter(r => r.a).length,"
                "  text: all.filter(r => r.x).length,"
                "  maxDwell: all.reduce((m, r) => Math.max(m, r.dwellMs), 0),"
                " }; })()")
            check('9. the reading log counted attention',
                  log['n'] > 20 and log['withDwell'] > 0 and log['opened'] > 0,
                  str(log))
            check('9b. it knows whose post it was',
                  log['authors'] > 0 and log['text'] > 0, str(log))

            # The options page: it reads the log back, and its own controls
            # work. A null lookup in wire() used to throw and take every
            # listener registered after it with it - Apply, Reset, both preset
            # pickers and all six content checkboxes did nothing at all.
            ext = sw.url.split('/')[2]
            opts = browser.new_page()
            errors = []
            opts.on('pageerror', lambda e: errors.append(str(e)[:160]))
            opts.goto('chrome-extension://%s/src/options/options.html' % ext)
            opts.wait_for_timeout(2000)
            check('10. the options page runs clean', not errors, '; '.join(errors))

            shown = opts.evaluate(
                "({body: !document.getElementById('gx-read-body').hidden,"
                "  totals: document.getElementById('gx-read-totals').children.length,"
                "  authors: document.getElementById('gx-read-authors').rows.length,"
                "  posts: document.getElementById('gx-read-posts').rows.length})")
            check('10b. it shows the reading back',
                  shown['body'] and shown['totals'] >= 6 and shown['authors'] > 0
                  and shown['posts'] > 0, str(shown))

            before = opts.evaluate(
                "(async () => ((await chrome.storage.local.get('gridxSettings'))"
                ".gridxSettings || {}).showMetrics)")
            opts.click('#gx-showMetrics')
            opts.wait_for_timeout(400)
            after = opts.evaluate(
                "(async () => ((await chrome.storage.local.get('gridxSettings'))"
                ".gridxSettings || {}).showMetrics)")
            check('10c. a content checkbox actually saves',
                  bool(after) != bool(before), '%s -> %s' % (before, after))
            opts.close()

            # An ordinary app served from localhost is none of GridX's
            # business unless it says so.
            page.goto('http://%s:%d/fixture_plain_app.html' % (HOST, PORT))
            page.wait_for_timeout(4000)
            quiet = page.evaluate(
                "({cls: document.documentElement.className,"
                "  overlay: !!document.getElementById('gridx-root'),"
                "  mirror: !!document.getElementById('gridx-mirror'),"
                "  says: /GridX/.test(document.body.innerText)})")
            check('8. a plain localhost app is left alone',
                  not quiet['overlay'] and not quiet['mirror']
                  and not quiet['says'] and 'gridx' not in quiet['cls'],
                  str(quiet))
    finally:
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        server.shutdown()

    print('\nGridX mirror test results:')
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(('  [PASS] ' if ok else '  [FAIL] ') + name)
    if bad:
        print('%d of %d checks FAILED.' % (len(bad), len(results)))
        return 1
    print('All %d checks PASSED.' % len(results))
    return 0


if __name__ == '__main__':
    sys.exit(main())
