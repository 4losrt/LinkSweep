import argparse
import asyncio
import json
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "e2e-results"


def safe_url(value):
    try:
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https", "chrome-extension") or not parts.hostname:
            return "[non-URL omitted]"
        return urlunsplit((parts.scheme, parts.hostname, parts.path, "", ""))
    except ValueError:
        return "[invalid URL omitted]"


def safe_text(value):
    return re.sub(r"https?://[^\s]+", lambda match: safe_url(match.group()), value)


def error_details(stage, error):
    return {
        "stage": stage,
        "type": type(error).__name__,
        "message": safe_text(str(error).splitlines()[0]),
        "network_errors": sorted(set(re.findall(r"net::ERR_[A-Z_]+", str(error)))),
    }


async def diagnose(worker, url):
    result = await asyncio.wait_for(worker.evaluate("""async url => {
        const result = await resolveSpecialURL(url, await getSettings(), true);
        return {resolved: result.resolved, safe: result.safe, changed: result.changed,
            output: result.output};
    }""", url), timeout=8)
    result["output"] = safe_url(result.get("output", ""))
    result["force"] = True
    details = await asyncio.wait_for(worker.evaluate("""async url => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const response = await fetch(url, {
                method: 'GET', redirect: 'follow', credentials: 'omit',
                cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal
            });
            const details = {status: response.status, url: response.url,
                redirected: response.redirected, type: response.type,
                content_type: response.headers.get('content-type')};
            if (response.body) await response.body.cancel();
            return details;
        } catch (error) {
            return {error_type: error.name};
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    }""", url), timeout=8)
    if "url" in details:
        details["url"] = safe_url(details["url"])
    return {"force_resolver": result, "separate_status_only_fetch": details}


async def observe(args):
    report = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "real_network_opt_in": args.allow_network,
        "input": safe_url(args.url),
        "expected": safe_url(args.expected),
        "headless": "new",
        "assertions": {"output_exact": False, "copy_enabled": False, "clipboard_exact": False},
        "network": [],
        "errors": [],
    }
    started = time.monotonic()
    profile_path = None
    try:
        with tempfile.TemporaryDirectory(prefix="linksweep-threads-live-") as profile:
            profile_path = Path(profile)
            async with async_playwright() as playwright:
                context = await playwright.chromium.launch_persistent_context(
                    profile,
                    channel="chromium",
                    headless=False,
                    viewport={"width": 480, "height": 900},
                    args=[
                        "--headless=new",
                        f"--disable-extensions-except={ROOT}",
                        f"--load-extension={ROOT}",
                        "--no-first-run",
                        "--no-default-browser-check",
                    ],
                )
                popup = None
                worker = None
                try:
                    report["browser_version"] = context.browser.version
                    context.set_default_timeout(10000)

                    def response_seen(response):
                        if urlsplit(response.url).hostname in ("threads.com", "www.threads.com"):
                            report["network"].append({
                                "seconds": round(time.monotonic() - started, 3),
                                "url": safe_url(response.url),
                                "status": response.status,
                                "redirected_from": safe_url(response.request.redirected_from.url)
                                if response.request.redirected_from else None,
                            })

                    context.on("response", response_seen)
                    workers = context.service_workers
                    worker = workers[0] if workers else await context.wait_for_event("serviceworker", timeout=15000)
                    assert worker.url.endswith("/background.js")
                    origin = worker.url.rsplit("/", 1)[0]
                    await context.grant_permissions(["clipboard-read", "clipboard-write"])
                    popup = await context.new_page()
                    await popup.goto(f"{origin}/popup.html")
                    await popup.wait_for_selector("#enabled:not([disabled])")
                    await popup.bring_to_front()
                    await popup.locator("#input").fill(args.url)
                    clean_started = time.monotonic()
                    await popup.locator("#clean").click()
                    await expect(popup.locator("#output")).not_to_have_value("", timeout=20000)
                    report["clean_seconds"] = round(time.monotonic() - clean_started, 3)
                    output = await popup.locator("#output").input_value()
                    report["output"] = safe_url(output)
                    report["clean_status"] = safe_text(await popup.locator("#manualStatus").inner_text())
                    report["assertions"]["output_exact"] = output == args.expected
                    report["assertions"]["copy_enabled"] = await popup.locator("#copy").is_enabled()
                    assert report["assertions"]["output_exact"], "Popup output differs from expected URL"
                    assert report["assertions"]["copy_enabled"], "Popup Copy is disabled"
                    await popup.locator("#copy").click()
                    await expect(popup.locator("#manualStatus")).not_to_have_text(report["clean_status"], timeout=5000)
                    report["copy_status"] = safe_text(await popup.locator("#manualStatus").inner_text())
                    clipboard = await asyncio.wait_for(popup.evaluate("navigator.clipboard.readText()"), timeout=5)
                    report["assertions"]["clipboard_exact"] = clipboard == args.expected
                    report["clipboard"] = safe_url(clipboard) if clipboard == args.expected else "[unexpected clipboard omitted]"
                    assert report["assertions"]["clipboard_exact"], "Actual clipboard differs from expected URL"
                except Exception as error:
                    report["errors"].append(error_details("popup_flow", error))
                    if worker:
                        try:
                            report["diagnostics"] = await diagnose(worker, args.url)
                        except Exception as diagnostic_error:
                            report["errors"].append(error_details("diagnostics", diagnostic_error))
                finally:
                    if popup and not popup.is_closed():
                        try:
                            report["final_status"] = safe_text(await popup.locator("#manualStatus").inner_text())
                            await popup.screenshot(path=str(ARTIFACTS / "threads-live.png"), full_page=True)
                            report["screenshot"] = "e2e-results/threads-live.png"
                        except Exception as error:
                            report["errors"].append(error_details("screenshot", error))
                    await context.close()
    except Exception as error:
        report["errors"].append(error_details("browser_or_cleanup", error))
    report["temporary_profile_cleaned"] = profile_path is not None and not profile_path.exists()
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    report["duration_seconds"] = round(time.monotonic() - started, 3)
    report["passed"] = all(report["assertions"].values()) and not report["errors"] and report["temporary_profile_cleaned"]
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    (ARTIFACTS / "threads-live.json").write_text(serialized + "\n", encoding="utf-8")
    print(serialized)
    return 0 if report["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description="Opt-in real-network Threads extension popup and clipboard observation")
    parser.add_argument("--url", required=True)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--allow-network", action="store_true", help="Explicitly permit live browser network requests")
    args = parser.parse_args()
    if not args.allow_network:
        parser.error("Live observation requires --allow-network; default tests do not run this script")
    for name in ("url", "expected"):
        value = getattr(args, name)
        try:
            parts = urlsplit(value)
            valid = parts.scheme == "https" and parts.hostname in ("threads.com", "www.threads.com") and not parts.username and not parts.password and not parts.port
        except ValueError:
            valid = False
        if not valid:
            parser.error(f"--{name} must be an HTTPS Threads URL without credentials or a custom port")
    if not ARTIFACTS.is_dir():
        parser.error("Expected existing e2e-results directory")
    return asyncio.run(observe(args))


if __name__ == "__main__":
    raise SystemExit(main())
