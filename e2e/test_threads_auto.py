import pytest

from playwright.sync_api import expect

SHARE = "https://www.threads.com/share/BrowserAutoCase/"
POST = "https://threads.com/@fixture/post/Verified"


@pytest.fixture()
def delayed_resolution(worker):
    worker.evaluate("""() => {
        globalThis.e2eOriginalFetch = fetch;
        globalThis.e2eRequests = 0;
        globalThis.e2eRelease = null;
        globalThis.fetch = async (...args) => {
            if (String(args[0]) !== 'https://www.threads.com/share/BrowserAutoCase/')
                return e2eOriginalFetch(...args);
            e2eRequests += 1;
            await new Promise(resolve => { e2eRelease = resolve; });
            const body = new Response('<head></head>', {headers:{'content-type':'text/html'}});
            return {ok:true,status:200,type:'basic',redirected:true,
                url:'https://www.threads.com/@fixture/post/Verified?xmt=test',
                headers:body.headers,body:body.body};
        };
        importScripts('special_resolver.js');
    }""")
    try:
        yield worker
    finally:
        worker.evaluate("""() => {
            if (e2eRelease) e2eRelease();
            globalThis.fetch = e2eOriginalFetch;
            importScripts('special_resolver.js');
        }""")


def start_copy(page):
    page.evaluate("""share => {
        window.e2eOutcome = 'pending';
        const button = document.createElement('button'); button.id='e2eShare';
        button.textContent='Test share copy';
        button.onclick = () => navigator.clipboard.writeText(share).then(
            () => { window.e2eOutcome='committed'; },
            error => { window.e2eOutcome='rejected:' + error.name; });
        document.body.prepend(button);
    }""", SHARE)
    page.click("#e2eShare")


def wait_request(page, worker):
    for _ in range(50):
        if worker.evaluate("e2eRequests"):
            return
        page.wait_for_timeout(100)
    raise AssertionError("No resolver request received from clipboard bridge")


def test_original_write_resolves_without_late_second_write(fixture_page, delayed_resolution):
    start_copy(fixture_page)
    wait_request(fixture_page, delayed_resolution)
    assert fixture_page.evaluate("e2eOutcome") == "pending"
    delayed_resolution.evaluate("e2eRelease()")
    fixture_page.wait_for_function("e2eOutcome === 'committed'")
    assert fixture_page.evaluate("navigator.clipboard.readText()") == POST


@pytest.mark.parametrize("new_copy", ["#copyNonUrl", "#copyRich"])
def test_new_copy_cancels_pending_share(fixture_page, delayed_resolution, new_copy):
    start_copy(fixture_page)
    wait_request(fixture_page, delayed_resolution)
    fixture_page.click(new_copy)
    fixture_page.wait_for_function("e2eOutcome.startsWith('rejected:')")
    delayed_resolution.evaluate("e2eRelease()")
    fixture_page.wait_for_timeout(1200)
    expected = "just a plain sentence, no links" if new_copy == "#copyNonUrl" else "https://example.com/?fbclid=abc123"
    assert fixture_page.evaluate("navigator.clipboard.readText()") == expected
    if new_copy == "#copyRich":
        assert fixture_page.evaluate("async () => (await navigator.clipboard.read())[0].types.includes('text/html')")


def test_disable_cancels_pending_share(fixture_page, delayed_resolution, popup):
    before = fixture_page.evaluate("navigator.clipboard.readText()")
    start_copy(fixture_page)
    wait_request(fixture_page, delayed_resolution)
    popup.bring_to_front()
    popup.locator('label[aria-label="切換自動清理"]').click()
    expect(popup.locator("#enabled")).not_to_be_checked()
    fixture_page.bring_to_front()
    fixture_page.wait_for_function("e2eOutcome.startsWith('rejected:')")
    delayed_resolution.evaluate("e2eRelease()")
    fixture_page.wait_for_timeout(1000)
    assert fixture_page.evaluate("navigator.clipboard.readText()") == before


def test_resolution_timeout_commits_original_share(fixture_page, delayed_resolution):
    start_copy(fixture_page)
    wait_request(fixture_page, delayed_resolution)
    fixture_page.wait_for_function("e2eOutcome === 'committed'", timeout=8000)
    assert fixture_page.evaluate("navigator.clipboard.readText()") == SHARE
