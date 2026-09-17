import argparse
import asyncio
import json
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

from threads_live import ARTIFACTS, ROOT, error_details, safe_url


async def inspect_controls(page):
    return await page.evaluate("""() => {
        const visible = element => Boolean(element.getClientRects().length);
        const controls = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], svg[aria-label]')).filter(visible);
        const label = element => (element.getAttribute('aria-label') || element.innerText || element.textContent || '').trim().slice(0, 100);
        return {
            visible_control_count: controls.length,
            relevant: controls.map(element => ({tag: element.tagName, role: element.getAttribute('role'), label: label(element)}))
                .filter(item => /share|copy|link|log in|login|sign|分享|複製/i.test(item.label)).slice(0, 25),
            dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).map(element => element.innerText.slice(0, 400)).slice(0, 3),
            login_text_count: Array.from(document.querySelectorAll('a, button, [role="button"], h1, h2')).filter(element => visible(element) && /log in|sign up/i.test(label(element))).length
        };
    }""")


async def first_visible(locator):
    for index in range(min(await locator.count(), 20)):
        candidate = locator.nth(index)
        if await candidate.is_visible():
            return candidate
    return None


async def install_observer(page):
    await page.wait_for_function("navigator.clipboard.__linkSweepWriteWrapped === true")
    await page.evaluate("""() => {
        window.__threadsCopyEvidence = {writes: [], events: []};
        const clipboard = navigator.clipboard;
        const existing = clipboard.writeText;
        clipboard.writeText = function(...args) {
            const record = {original: typeof args[0] === 'string' ? args[0] : '[non-string]', status: 'pending', at: performance.now()};
            window.__threadsCopyEvidence.writes.push(record);
            try {
                const result = Reflect.apply(existing, this, args);
                Promise.resolve(result).then(() => { record.status = 'fulfilled'; }, error => { record.status = error.name; });
                return result;
            } catch (error) {
                record.status = error.name;
                throw error;
            }
        };
        window.addEventListener('message', event => {
            if (event.source !== window || !event.data) return;
            const data = event.data;
            if (['clean-urls-copy', 'clean-urls-copy-navigation'].includes(data.source)
                && ['clipboard-resolve-request', 'clipboard-resolve-result'].includes(data.type)) {
                window.__threadsCopyEvidence.events.push({type: data.type, input: data.input,
                    output: data.result?.output, resolved: data.result?.resolved, at: performance.now()});
            }
        });
    }""")


async def clipboard_evidence(page, reader, expected):
    await page.wait_for_timeout(7000)
    evidence = await page.evaluate("window.__threadsCopyEvidence")
    read_details = {"clipboard_read_context": "Threads page"}
    try:
        clipboard = await asyncio.wait_for(page.evaluate("navigator.clipboard.readText()"), timeout=5)
    except Exception as error:
        read_details = {"clipboard_read_context": "extension page, read only after Threads write",
            "threads_read_error": error_details("threads_clipboard_read", error)}
        await reader.bring_to_front()
        clipboard = await asyncio.wait_for(reader.evaluate("navigator.clipboard.readText()"), timeout=5)
        await page.bring_to_front()
    return {
        **evidence,
        **read_details,
        "clipboard": clipboard if clipboard == expected or clipboard.startswith("https://www.threads.com/") or clipboard.startswith("https://threads.com/") else "[unexpected clipboard omitted]",
        "clipboard_exact": clipboard == expected,
        "share_source_observed": any(urlsplit(item["original"]).path.startswith("/share/") for item in evidence["writes"]),
    }


async def observe(args):
    report = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "real_network_opt_in": args.allow_network,
        "page_url": safe_url(args.page_url),
        "input": safe_url(args.url),
        "expected": safe_url(args.expected),
        "profile": "isolated temporary Chromium, no login or profile reuse",
        "headless": "new",
        "native": {"share_clicked": False, "copy_clicked": False, "tested": False},
        "harness": {"tested": False},
        "network": [],
        "errors": [],
        "screenshots": [],
    }
    artifact_prefix = args.artifact_prefix
    profile_path = None
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="linksweep-threads-copy-live-") as profile:
            profile_path = Path(profile)
            async with async_playwright() as playwright:
                context = await playwright.chromium.launch_persistent_context(
                    profile, channel="chromium", headless=False,
                    viewport={"width": 1100, "height": 900}, locale="en-US",
                    args=["--headless=new", f"--disable-extensions-except={ROOT}",
                          f"--load-extension={ROOT}", "--no-first-run", "--no-default-browser-check"],
                )
                page = None
                try:
                    report["browser_version"] = context.browser.version
                    context.set_default_timeout(10000)
                    workers = context.service_workers
                    worker = workers[0] if workers else await context.wait_for_event("serviceworker", timeout=15000)
                    assert worker.url.endswith("/background.js")
                    report["settings"] = await worker.evaluate("chrome.storage.local.get({enabled: true, referralMarketing: false})")
                    assert report["settings"]["enabled"] is True
                    await context.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://www.threads.com")
                    await context.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://threads.com")
                    reader = await context.new_page()
                    await reader.goto(worker.url.rsplit("/", 1)[0] + "/popup.html")
                    await reader.wait_for_selector("#enabled:not([disabled])")
                    page = await context.new_page()

                    def response_seen(response):
                        parts = urlsplit(response.url)
                        if parts.hostname in ("threads.com", "www.threads.com") and (parts.path.startswith("/share/") or "/post/" in parts.path):
                            report["network"].append({"url": safe_url(response.url), "status": response.status,
                                "seconds": round(time.monotonic() - started, 3),
                                "redirected_from": safe_url(response.request.redirected_from.url) if response.request.redirected_from else None})

                    context.on("response", response_seen)
                    response = await page.goto(args.page_url, wait_until="domcontentloaded", timeout=60000)
                    report["navigation_status"] = response.status if response else None
                    await page.wait_for_timeout(6000)
                    await page.bring_to_front()
                    report["landed_url"] = safe_url(page.url)
                    report["initial_controls"] = await inspect_controls(page)
                    await install_observer(page)
                    await page.screenshot(path=str(ARTIFACTS / f"{artifact_prefix}-initial.png"))
                    report["screenshots"].append(f"e2e-results/{artifact_prefix}-initial.png")
                    share = await first_visible(page.get_by_role("button", name=re.compile(r"^Share(?:\s|$)", re.I)))
                    if share is None:
                        share = await first_visible(page.locator('svg[aria-label="Share"]').locator('xpath=ancestor::*[@role="button" or self::button][1]'))
                    if share is not None:
                        await share.click()
                        report["native"]["share_clicked"] = True
                        await page.wait_for_timeout(1500)
                    report["after_share_controls"] = await inspect_controls(page)
                    copy = await first_visible(page.get_by_role("menuitem", name=re.compile(r"^Copy link$", re.I)))
                    if copy is None:
                        copy = await first_visible(page.get_by_role("button", name=re.compile(r"^Copy link$", re.I)))
                    if copy is None:
                        copy = await first_visible(page.get_by_text("Copy link", exact=True))
                    if copy is not None:
                        await copy.click()
                        report["native"].update({"copy_clicked": True, "tested": True})
                        report["native"].update(await clipboard_evidence(page, reader, args.expected))
                    else:
                        report["native"]["unavailable_reason"] = "No publicly accessible Copy link action found in the inspected logged-out UI; see controls and screenshot"
                    await page.screenshot(path=str(ARTIFACTS / f"{artifact_prefix}-native.png"))
                    report["screenshots"].append(f"e2e-results/{artifact_prefix}-native.png")
                    if not report["native"]["tested"] and args.harness_if_unavailable:
                        await page.keyboard.press("Escape")
                        await page.evaluate("""url => {
                            window.__threadsCopyEvidence.writes.length = 0;
                            window.__threadsCopyEvidence.events.length = 0;
                            const button = document.createElement('button');
                            button.id = 'linksweep-threads-copy-harness';
                            button.textContent = 'LinkSweep TEST HARNESS: copy supplied share URL (not native Threads)';
                            button.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;padding:18px;background:#fff;color:#000;border:3px solid #b00';
                            button.addEventListener('click', () => {
                                navigator.clipboard.writeText(url).then(() => {
                                    button.textContent = 'TEST HARNESS: clipboard write fulfilled (not native Threads)';
                                }, error => { button.textContent = 'TEST HARNESS: ' + error.name; });
                            });
                            document.body.appendChild(button);
                        }""", args.url)
                        await page.locator("#linksweep-threads-copy-harness").click()
                        report["harness"] = {"tested": True, "native_threads_action": False}
                        report["harness"].update(await clipboard_evidence(page, reader, args.expected))
                        await page.screenshot(path=str(ARTIFACTS / f"{artifact_prefix}-harness.png"))
                        report["screenshots"].append(f"e2e-results/{artifact_prefix}-harness.png")
                        assert report["harness"]["share_source_observed"], "Harness source was not a share URL"
                        assert report["harness"]["clipboard_exact"], "Harness native clipboard differs from expected URL"
                    if report["native"]["tested"]:
                        assert report["native"]["clipboard_exact"], "Native Copy link clipboard differs from expected URL"
                except Exception as error:
                    report["errors"].append(error_details("live_copy", error))
                    if page and not page.is_closed():
                        await page.screenshot(path=str(ARTIFACTS / f"{artifact_prefix}-error.png"))
                        report["screenshots"].append(f"e2e-results/{artifact_prefix}-error.png")
                finally:
                    await context.close()
    except Exception as error:
        report["errors"].append(error_details("browser_or_cleanup", error))
    report["temporary_profile_cleaned"] = profile_path is not None and not profile_path.exists()
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    report["duration_seconds"] = round(time.monotonic() - started, 3)
    report["native_passed"] = report["native"].get("clipboard_exact", False) and report["native"]["tested"]
    report["harness_passed"] = report["harness"].get("clipboard_exact", False) and report["harness"]["tested"]
    report["observation_passed"] = (report["native_passed"] or report["harness_passed"]) and not report["errors"] and report["temporary_profile_cleaned"]
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    (ARTIFACTS / f"{artifact_prefix}.json").write_text(serialized + "\n", encoding="utf-8")
    print(serialized)
    return 0 if report["observation_passed"] else 1


def main():
    parser = argparse.ArgumentParser(description="Opt-in logged-out native Threads Copy link observation with optional explicitly labeled harness")
    parser.add_argument("--allow-network", action="store_true")
    parser.add_argument("--page-url", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--harness-if-unavailable", action="store_true")
    parser.add_argument("--artifact-prefix", default="threads-copy-live")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.artifact_prefix):
        parser.error("--artifact-prefix must contain only letters, digits, underscores or hyphens")
    if not args.allow_network:
        parser.error("Live observation requires --allow-network")
    for name in ("page_url", "url", "expected"):
        try:
            parts = urlsplit(getattr(args, name))
            valid = parts.scheme == "https" and parts.hostname in ("threads.com", "www.threads.com") and not parts.username and not parts.password and not parts.port
        except ValueError:
            valid = False
        if not valid:
            parser.error(f"--{name.replace('_', '-')} must be an HTTPS Threads URL without credentials or custom port")
    if not urlsplit(args.url).path.startswith("/share/"):
        parser.error("--url must supply a Threads /share/ URL for the optional harness")
    if not ARTIFACTS.is_dir():
        parser.error("Expected existing e2e-results directory")
    return asyncio.run(observe(args))


if __name__ == "__main__":
    raise SystemExit(main())
