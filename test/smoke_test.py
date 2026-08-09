#!/usr/bin/env python3
"""GridX Playwright smoke test.

Launches Chrome for Testing (headful) with the extension loaded, serves
test/fixture.html over a local http.server, and asserts all 7 checks:

  1. #gridx-root exists on the page.
  2. at least 20 articles were hoisted into the grid.
  3. the grid has exactly the configured (default 3) CSS columns.
  4. clicking the fixture's "load more" grows the grid (MutationObserver proof).
  5. a gridx:update {columnCount:4} message changes the computed column count.
  6. a keyword filter hides matching posts.
  7. enabling scan mode adds the `gridx-scan` class to <html>.

Notes:
- headless MUST be False for --load-extension to work.
- Chrome for Testing is discovered by glob: first /tmp/pw-browsers/*,
  then Playwright's own ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome,
  falling back to Playwright's default executable. If none is found we skip
  cleanly with exit 0 and a note.
"""
import glob
import http.server
import os
import re
import socketserver
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_DIR = os.path.join(REPO, 'test')
PORT = 8765
HOST = '127.0.0.1'

PASS = 'PASS'
FAIL = 'FAIL'


def find_chrome():
    candidates = []
    for pat in [
        '/tmp/pw-browsers/*/chrome*',
        '/tmp/pw-browsers/chrome*/chrome-linux64/chrome',
        os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome'),
    ]:
        candidates.extend(glob.glob(pat))

    def rev(path):
        m = re.search(r'chromium-(\d+)', path)
        return int(m.group(1)) if m else 0
    # Executables only; prefer newest Chromium revision.
    exes = [c for c in candidates if os.path.isfile(c) and os.access(c, os.X_OK)]
    exes.sort(key=rev)
    if exes:
        return exes[-1]
    # Fall back to Playwright's default.
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            return p.chromium.executable_path
    except Exception:
        return None


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


# ThreadingTCPServer does not set SO_REUSEADDR by default, so binding right
# after a previous run (port in TIME_WAIT) fails with EADDRINUSE for up to
# 2*MSL (~60s). Enable reuse so rapid re-runs always work.
class ReuseTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server():
    handler = lambda *a, **kw: QuietHandler(*a, directory=TEST_DIR, **kw)
    httpd = None
    last_err = None
    for _ in range(25):  # ~5s of retries (a just-released port can be in TIME_WAIT)
        try:
            httpd = ReuseTCPServer((HOST, PORT), handler)
            break
        except OSError as e:
            last_err = e
            time.sleep(0.2)
    if httpd is None:
        raise last_err
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def wait_for(cond, timeout=20.0, interval=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


def main():
    chrome = find_chrome()
    if not chrome:
        print('SKIP: Chrome for Testing binary not found; cannot run smoke test.')
        print('Looked in /tmp/pw-browsers and ~/.cache/ms-playwright. Install via')
        print('`playwright install chromium` or drop a build into /tmp/pw-browsers.')
        return 0

    print('Using Chrome for Testing: %s' % chrome)

    server = start_server()
    results = []
    user_data = tempfile.mkdtemp(prefix='gridx-pw-')
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
            page_errors = []
            page.on('pageerror', lambda e: page_errors.append(str(e)))
            page.on('console', lambda m: page_errors.append(m.text)
                    if m.type == 'error' else None)

            url = 'http://%s:%d/%s' % (HOST, PORT, 'fixture.html')
            page.goto(url, wait_until='load', timeout=30000)

            # --- Check 1: grid overlay exists --------------------------------
            ok1 = wait_for(lambda: page.evaluate(
                "() => !!document.querySelector('#gridx-root')"))
            results.append(('1. gridx overlay element exists', ok1))

            # --- Check 2: stream host found + >= 20 articles present ---------
            def host_count():
                return page.evaluate("""() => {
                    const h = document.querySelector('.gx-stream');
                    return h ? h.querySelectorAll('article[data-testid="tweet"], article').length : -1;
                }""")
            ok2 = wait_for(lambda: host_count() >= 20)
            count_start = host_count()
            results.append(('2. stream host + >=20 articles (%d)' % count_start, ok2))

            # --- Check 3: default CSS columns on the host == 3 ----------------
            def col_count():
                return page.evaluate("""() => {
                    const h = document.querySelector('.gx-stream');
                    if (!h) return 0;
                    return getComputedStyle(h).gridTemplateColumns
                        .split(/\\s+/).filter(Boolean).length;
                }""")
            cols = col_count()
            results.append(('3. host has configured columns (got %d, want 3)' % cols,
                            cols == 3))

            # --- Check 4: load more grows the hosted grid (MutationObserver) ---
            before = host_count()
            page.evaluate("() => document.getElementById('load-more').click()")
            ok4 = wait_for(lambda: host_count() == before + 5)
            results.append(
                ('4. load more grows grid (%d -> %d)' % (before, host_count()), ok4))

            # --- Check 5: gridx:update columnCount=4 --------------------------
            page.evaluate(
                "() => document.dispatchEvent(new CustomEvent('gridx:update',"
                " { detail: { columnCount: 4 } }))")
            cols5 = col_count()
            results.append(
                ('5. gridx:update columnCount=4 -> %d columns' % cols5, cols5 == 4))

            # --- Check 6: keyword filter hides matching posts ------------------
            page.evaluate(
                "() => document.dispatchEvent(new CustomEvent('gridx:update',"
                " { detail: { filterKeywords: ['banana'] } }))")
            def filter_stats():
                return page.evaluate("""() => {
                    const h = document.querySelector('.gx-stream');
                    const arts = h ? Array.from(h.querySelectorAll('article[data-testid="tweet"], article')) : [];
                    const banana = arts.filter(a => (a.innerText||a.textContent||'').includes('banana'));
                    const hiddenBanana = banana.filter(a => a.classList.contains('gx-hidden'));
                    const visible = arts.filter(a => !a.classList.contains('gx-hidden')).length;
                    return { total: banana.length, hidden: hiddenBanana.length, visible: visible };
                }""")
            fs = filter_stats()
            ok6 = (fs['total'] > 0 and fs['hidden'] == fs['total'])
            results.append(
                ('6. keyword filter hides %d/%d banana posts (visible now %d)'
                 % (fs['hidden'], fs['total'], fs['visible']), ok6))

            # --- Check 7: scan mode adds gridx-scan to <html> ------------------
            page.evaluate(
                "() => document.dispatchEvent(new CustomEvent('gridx:update',"
                " { detail: { scanMode: true } }))")
            def html_scan():
                return page.evaluate(
                    "() => document.documentElement.classList.contains('gridx-scan')")
            ok7 = wait_for(html_scan)
            results.append(('7. scan mode adds gridx-scan to <html>', ok7))

            # Screenshot is intentionally omitted: Playwright's screenshot
            # waiter can spin on the grid's `content-visibility` cells + the
            # 1s stats refresh. The DOM/ComputedStyle assertions above are the
            # proof of correctness, not a pixel capture.

            if page_errors:
                print('\n-- page errors observed --')
                for e in page_errors[:10]:
                    print('  ', e)
    finally:
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        try:
            server.shutdown()
        except Exception:
            pass
        server.server_close()

    print('\nGridX smoke test results:')
    all_ok = True
    for label, ok in results:
        print('  [%s] %s' % (PASS if ok else FAIL, label))
        all_ok = all_ok and ok

    if not all_ok:
        print('One or more checks FAILED.')
        return 1
    print('All 7 checks PASSED.')
    return 0


if __name__ == '__main__':
    sys.exit(main())