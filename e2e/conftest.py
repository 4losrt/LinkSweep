import http.server
import os
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "e2e-results"


@pytest.fixture(scope="session")
def server_url():
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / "e2e" / "pages"), **kwargs)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


@pytest.fixture(scope="session")
def browser():
    ARTIFACTS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="linksweep-e2e-") as profile, sync_playwright() as p:
        args = [
            f"--disable-extensions-except={ROOT}",
            f"--load-extension={ROOT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
        ]
        if os.environ.get("LINKSWEEP_HEADED") != "1":
            args.append("--headless=new")
        context = p.chromium.launch_persistent_context(profile, headless=False, args=args)
        context.set_default_timeout(7000)
        context.grant_permissions(["clipboard-read", "clipboard-write"])
        context.route("**/*", lambda route: route.continue_()
                      if urlparse(route.request.url).hostname in ("127.0.0.1", "localhost")
                      or route.request.url.startswith("chrome-extension://") else route.abort())
        try:
            yield context
        finally:
            context.close()


@pytest.fixture(scope="session")
def worker(browser):
    workers = browser.service_workers
    result = workers[0] if workers else browser.wait_for_event("serviceworker", timeout=15000)
    assert result.url.endswith("/background.js"), result.url
    return result


@pytest.fixture(scope="session")
def extension_id(worker):
    return worker.url.split("/")[2]


@pytest.fixture()
def popup(browser, extension_id):
    page = browser.new_page()
    page.goto(f"chrome-extension://{extension_id}/popup.html")
    page.wait_for_selector("#enabled:not([disabled])", state="attached")
    for key, value in (("enabled", True), ("pasteClean", False), ("referralMarketing", False)):
        result = page.evaluate("([key, value]) => chrome.runtime.sendMessage({type:'setSetting',key,value})", [key, value])
        assert not result.get("error"), result
    try:
        yield page
    finally:
        if not page.is_closed():
            page.close()


@pytest.fixture()
def fixture_page(browser, server_url, popup, request):
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{server_url}/fixture.html")
    page.wait_for_function("navigator.clipboard.__linkSweepWriteWrapped === true")
    page.evaluate("navigator.clipboard.writeText('https://example.com/?fbclid=ready')")
    page.wait_for_function("async () => await navigator.clipboard.readText() === 'https://example.com/'")
    try:
        yield page
    finally:
        report = getattr(request.node, "rep_call", None)
        if report and report.failed:
            page.screenshot(path=str(ARTIFACTS / f"{request.node.name}.png"), full_page=True)
            (ARTIFACTS / f"{request.node.name}.errors.txt").write_text("\n".join(errors), encoding="utf-8")
        page.close()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    result = outcome.get_result()
    setattr(item, "rep_" + result.when, result)
