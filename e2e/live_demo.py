"""Live demo: real Chromium run with the extension, capturing screenshots.

- Isolated temporary profile (personal Chrome data untouched)
- Local fixture page only; no external network
- Writes clipboard via the page, reads it back, screenshots each step
"""
import http.server
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "e2e-results" / "demo"
OUT.mkdir(parents=True, exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "e2e" / "pages"), **kwargs)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(prefix="linksweep-demo-"),
        headless=False,
        args=[
            f"--disable-extensions-except={ROOT}",
            f"--load-extension={ROOT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
        ],
    )
    context.grant_permissions(["clipboard-read", "clipboard-write"])
    time.sleep(1.5)

    page = context.new_page()
    page.goto(f"{base}/fixture.html")
    page.wait_for_function("navigator.clipboard.__linkSweepWriteWrapped === true")
    page.screenshot(path=str(OUT / "1-fixture.png"))

    page.click("#copyTracked")
    page.wait_for_function(
        "() => document.querySelector('#status').textContent.includes('committed')")
    time.sleep(0.3)
    cleaned = page.evaluate("navigator.clipboard.readText()")
    page.screenshot(path=str(OUT / "2-after-copy.png"))

    page.click("#copyRich")
    time.sleep(0.5)
    rich = page.evaluate("""async () => {
        const [item] = await navigator.clipboard.read();
        return {types: item.types, html: await (await item.getType('text/html')).text()};
    }""")

    page.click("#copyShare")
    time.sleep(0.5)
    share = page.evaluate("navigator.clipboard.readText()")

    worker = context.service_workers[0]
    extension_id = worker.url.split("/")[2]
    popup = context.new_page()
    popup.goto(f"chrome-extension://{extension_id}/popup.html")
    popup.wait_for_selector("#enabled:not([disabled])")
    popup.fill("#input", "https://example.com/?fbclid=abc123&utm_source=news")
    popup.click("#clean")
    popup.wait_for_function("() => document.querySelector('#output').value !== ''")
    popup.screenshot(path=str(OUT / "3-popup-manual.png"))

    context.close()
    server.shutdown()

print("clipboard after tracked copy :", cleaned)
print("rich item types / html       :", rich)
print("threads share kept           :", share)
print("screenshots saved to:", OUT)
