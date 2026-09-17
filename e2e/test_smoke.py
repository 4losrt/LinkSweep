import sys

from playwright.sync_api import expect

DIRTY = "https://example.com/?fbclid=abc123&utm_source=news"
CLEAN = "https://example.com/"


def wait_status(page, text):
    expect(page.locator("#status")).to_have_text(text)


def test_write_text_copy_is_cleaned(fixture_page):
    fixture_page.click("#copyTracked")
    wait_status(fixture_page, "writeText committed")
    assert fixture_page.evaluate("navigator.clipboard.readText()") == CLEAN


def test_non_url_and_rapid_copy_order(fixture_page):
    fixture_page.click("#copyTracked")
    fixture_page.click("#copyNonUrl")
    wait_status(fixture_page, "non-url committed")
    fixture_page.wait_for_timeout(7000)
    assert fixture_page.evaluate("navigator.clipboard.readText()") == "just a plain sentence, no links"


def test_rich_clipboard_preserves_html_and_plain(fixture_page):
    fixture_page.click("#copyRich")
    wait_status(fixture_page, "rich write committed")
    value = fixture_page.evaluate("""async () => {
        const [item] = await navigator.clipboard.read();
        return {types: item.types, text: await (await item.getType('text/plain')).text(),
            html: await (await item.getType('text/html')).text()};
    }""")
    assert "text/html" in value["types"]
    assert value["text"] == "https://example.com/?fbclid=abc123"
    assert "<b>hello</b>" in value["html"]


def test_threads_share_never_replaced_with_nearby_post(fixture_page):
    fixture_page.evaluate("""() => {
        const a = document.createElement('a');
        a.href = 'https://www.threads.com/@wrong/post/Wrong';
        a.textContent = 'Share'; document.body.prepend(a);
    }""")
    fixture_page.click("#copyShare")
    wait_status(fixture_page, "share committed")
    assert fixture_page.evaluate("navigator.clipboard.readText()") == "https://www.threads.com/share/Test123/"
    fixture_page.click("#copyNonUrl")
    fixture_page.wait_for_timeout(1200)
    assert fixture_page.evaluate("navigator.clipboard.readText()") == "just a plain sentence, no links"


def test_real_keyboard_copy_plain_selection(fixture_page):
    fixture_page.evaluate("""value => {
        const p = document.createElement('p'); p.id = 'copyTarget'; p.textContent = value;
        document.body.append(p);
        const range = document.createRange();
        range.setStart(p.firstChild, 0); range.setEnd(p.firstChild, value.length);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    }""", DIRTY)
    fixture_page.keyboard.press("Meta+c" if sys.platform == "darwin" else "Control+c")
    fixture_page.wait_for_function("async () => await navigator.clipboard.readText() === 'https://example.com/'")


def test_click_request_is_clean_before_navigation(fixture_page, server_url):
    url = f"{server_url}/fixture.html?q=boots&fbclid=test"
    fixture_page.locator("#trackedLink").evaluate("(a, url) => a.href = url", url)
    with fixture_page.expect_request(lambda r: r.is_navigation_request() and "q=boots" in r.url) as request:
        fixture_page.click("#trackedLink")
    assert request.value.url == f"{server_url}/fixture.html?q=boots"


def test_window_open_request_is_clean(fixture_page, browser, server_url):
    url = f"{server_url}/fixture.html?page=2&fbclid=test"
    with browser.expect_page() as pending:
        fixture_page.evaluate("url => window.open(url, '_blank')", url)
    opened = pending.value
    try:
        opened.wait_for_load_state()
        assert opened.url == f"{server_url}/fixture.html?page=2"
    finally:
        opened.close()


def test_functional_signed_and_raw_encoding_preserved(fixture_page):
    pairs = [
        ("https://example.com/?q=a%20b&s=boots&page=2&fbclid=x#section", "https://example.com/?q=a%20b&s=boots&page=2#section"),
        ("https://example.com/?token=secret&fbclid=x", "https://example.com/?token=secret&fbclid=x"),
        ("https://www.youtube.com/watch?v=video&list=playlist&index=2&t=80&fbclid=x", "https://www.youtube.com/watch?v=video&list=playlist&index=2&t=80"),
    ]
    for original, expected in pairs:
        fixture_page.evaluate("url => navigator.clipboard.writeText(url)", original)
        assert fixture_page.evaluate("navigator.clipboard.readText()") == expected


def test_popup_manual_copy_and_stale_input_guard(popup):
    popup.bring_to_front()
    popup.fill("#input", "https://example.com/?fbclid=x")
    popup.click("#clean")
    expect(popup.locator("#output")).to_have_value(CLEAN)
    expect(popup.locator("#copy")).to_be_enabled()
    popup.click("#copy")
    expect(popup.locator("#manualStatus")).to_contain_text("已複製")
    assert popup.evaluate("navigator.clipboard.readText()") == CLEAN
    popup.fill("#input", "https://example.com/changed")
    expect(popup.locator("#copy")).to_be_disabled()
    expect(popup.locator("#output")).to_have_value("")


def test_master_off_passthrough_manual_still_available(popup, fixture_page):
    popup.bring_to_front()
    popup.locator('label[aria-label="切換自動清理"]').click()
    expect(popup.locator("#enabled")).not_to_be_checked()
    expect(popup.locator("#pasteClean")).to_be_disabled()
    fixture_page.bring_to_front()
    fixture_page.click("#copyTracked")
    wait_status(fixture_page, "writeText committed")
    assert fixture_page.evaluate("navigator.clipboard.readText()") == DIRTY
    popup.bring_to_front()
    popup.fill("#input", "https://example.com/?fbclid=x")
    popup.click("#clean")
    expect(popup.locator("#output")).to_have_value(CLEAN)
    popup.reload()
    expect(popup.locator("#enabled")).not_to_be_checked()


def test_passive_opt_in_lifecycle(popup, worker):
    expect(popup.locator("#pasteClean")).not_to_be_checked()
    popup.wait_for_function("async () => !await chrome.offscreen.hasDocument()")
    popup.locator('label[aria-label="切換被動剪貼簿清理"]').click()
    expect(popup.locator("#pasteClean")).to_be_checked()
    popup.wait_for_function("async () => await chrome.offscreen.hasDocument()")
    popup.reload()
    expect(popup.locator("#pasteClean")).to_be_checked()
    popup.locator('label[aria-label="切換被動剪貼簿清理"]').click()
    popup.wait_for_function("async () => !await chrome.offscreen.hasDocument()")


def test_passive_monitor_cleans_plain_and_preserves_rich(popup):
    popup.bring_to_front()
    popup.locator('label[aria-label="切換被動剪貼簿清理"]').click()
    expect(popup.locator("#pasteClean")).to_be_checked()
    popup.wait_for_function("async () => await chrome.offscreen.hasDocument()")
    popup.evaluate("() => navigator.clipboard.writeText('https://example.com/?fbclid=passive')")
    popup.wait_for_function("async () => await navigator.clipboard.readText() === 'https://example.com/'")
    popup.evaluate("""() => navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob(['https://example.com/?fbclid=rich'], {type:'text/plain'}),
        'text/html': new Blob(['<b>keep rich</b>'], {type:'text/html'})
    })])""")
    popup.wait_for_timeout(3200)
    result = popup.evaluate("""async () => {
        const [item] = await navigator.clipboard.read();
        return {types:item.types, text:await (await item.getType('text/plain')).text()};
    }""")
    assert 'text/html' in result['types']
    assert result['text'] == 'https://example.com/?fbclid=rich'
    popup.locator('label[aria-label="切換被動剪貼簿清理"]').click()
    popup.wait_for_function("async () => !await chrome.offscreen.hasDocument()")


def test_pure_clipboard_item_is_cleaned(fixture_page):
    fixture_page.evaluate("""value => navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([value], {type:'text/plain'})
    })])""", DIRTY)
    assert fixture_page.evaluate("navigator.clipboard.readText()") == CLEAN


def test_editable_keyboard_copy_is_untouched(fixture_page):
    fixture_page.evaluate("""value => {
        const input = document.createElement('textarea'); input.value=value;
        document.body.append(input); input.focus(); input.select();
    }""", DIRTY)
    fixture_page.keyboard.press("Meta+c" if sys.platform == "darwin" else "Control+c")
    fixture_page.wait_for_function("async value => await navigator.clipboard.readText() === value", arg=DIRTY)


def test_legacy_opt_in_migration(popup):
    popup.evaluate("() => chrome.storage.local.set({pasteCleanOptInVersion:0, pasteClean:true})")
    popup.reload()
    expect(popup.locator("#enabled")).to_be_enabled()
    expect(popup.locator("#pasteClean")).not_to_be_checked()
    popup.wait_for_function("async () => !await chrome.offscreen.hasDocument()")
