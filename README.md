# LinkSweep — Clean URLs

[繁體中文 README](README.zh-TW.md)

> **Production credit:** This project was completed with assistance from Manus, including feature design, Manifest V3 implementation, testing, license organization, and GitHub documentation.

LinkSweep is a Chrome Manifest V3 extension for cleaning copied and opened URLs. It removes tracking parameters only when the result can be verified as safe, while preserving functional values such as YouTube video IDs, playlists, indexes, timestamps, and other content identifiers.

## [📥 Download Latest LinkSweep.crx](https://github.com/4losrt/LinkSweep/releases/latest/download/LinkSweep.crx)

## Features

| Feature | Behaviour |
|---|---|
| Copy cleaning | Cleans URLs from interceptable `copy` events. |
| Programmatic Clipboard cleaning | Cleans `navigator.clipboard.writeText()` and single, pure `text/plain` ClipboardItem writes, including verified automatic Threads share restoration. Mixed MIME and rich items remain untouched; see cancellation and API limits below. |
| Passive Clipboard monitoring | Off by default, including once after upgrading from an older version. When explicitly enabled, an MV3 offscreen document reads the clipboard with `navigator.clipboard.read()` about every 1.5 seconds, processes only a single item whose only representation is `text/plain`, and writes back only a verified, changed plain URL. Rich items (HTML, images, multiple representations) and multi-URL or plain text are passed through untouched. A short race window between the final check and the write remains; keep this off if that is unacceptable. |
| Click/open cleaning | Cleans supported link clicks, `window.open`, and selected navigation paths before opening. |
| Threads resolution | Converts a verified `/share/XXXX/` URL into `/@username/post/POST_ID`; unverifiable results remain unchanged. |
| YouTube protection | Keeps video, playlist, index, time, and other functional parameters while removing known tracking parameters. |
| Manual fallback | Popup and context-menu cleaning remain available even when automatic cleaning is disabled. |

## Install in Chrome

1. Download and extract this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the extracted repository folder containing `manifest.json`.
6. Reload the extension and refresh already-open web pages.

The Popup has two controls. **Automatic cleaning** is the master switch for automatic copy, Clipboard, click, and open cleaning. **Passive Clipboard cleaning** controls only the offscreen Clipboard monitor and is off by default; after upgrading, a previously stored enabled state is turned off exactly once and you must opt in again. Manual Popup cleaning remains available as an explicit action: the popup only copies a URL that the extension itself cleaned and verified, and it does not promise that every tracking parameter has been removed.

## Conservative behaviour

LinkSweep does not modify ordinary text, multi-line clipboard content, malformed URLs, or special URLs that cannot be verified. Threads resolution can be affected by redirects, login walls, CORS, HTTP 429 responses, network restrictions, or changes to public canonical metadata. In those cases LinkSweep uses a fail-closed strategy and keeps the original `/share/XXXX/` URL instead of guessing a post ID.

## Privacy and permissions

LinkSweep has no account system, analytics endpoint, or maintainer-operated upload service. Clipboard contents are processed locally. The Threads resolver may request the public URL being resolved so that redirects or public metadata can be verified.

| Permission | Purpose |
|---|---|
| `storage` | Stores switches, counters, and the last cleaning record. |
| `clipboardRead` | Reads the clipboard only for the optional passive URL-cleaning monitor. |
| `clipboardWrite` | Writes back only when a safe result is different. |
| `offscreen` | Provides a hidden document for Clipboard DOM APIs in MV3. |
| `contextMenus` | Provides manual context-menu cleaning. |
| `scripting` | Supports explicit context-menu copying. |
| `<all_urls>` host permission | Allows copy and navigation handling across sites; it is not a browsing-history collection service. |

## Rule sources

The bundled `rules.js` combines LinkSweep code with selected, conservatively converted data from [ClearURLs Addon][1] and [ClearURLs Rules][2], [AdGuard Filters][3], and [uBlock Origin uAssets][4]. LinkSweep does not embed the AdGuard or uBlock filter engines. Unsupported redirects, remove-all rules, complex modifiers, and rules whose semantics cannot be preserved safely are skipped.

The rule-source licenses and attribution are documented in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`SOURCE-NOTICES.md`](SOURCE-NOTICES.md), [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md), and the files under `vendor/`.

## Optional rebuild

The bundled `rules.js` and `navigation_main_bundle.js` are ready to load. After changing source files or vendor snapshots, rebuild from the repository root:

```bash
python3 -B build_copy_rules.py
python3 -B build_navigation_bundle.py
```

## Extension-only operation and limits

Disable the LinkSweep Tampermonkey script yourself before using this version; the extension cannot disable userscripts. Ordinary `writeText()` URL cleaning is local and invokes the native write immediately. With automatic cleaning enabled, Threads `/share/` copies through `writeText()` or a single, pure `text/plain` ClipboardItem invoke native `clipboard.write()` immediately with a promise-backed Blob in a ClipboardItem. The verified resolver supplies the payload for that same write; there is no delayed second write. Unverified resolution or the six-second payload timeout uses the original share URL. If the required APIs are unavailable, the original write passes through unchanged.

A newer intercepted write in the same frame (including plain text or rich data), or disabling automatic cleaning, cancels an unresolved payload and rejects the pending write. Once the payload has settled, LinkSweep cannot retract the native commit. Ordering is not guaranteed against other frames, retained unwrapped API references, or external application writes. Mixed-MIME, rich and multi-item writes are passed through untouched.

The MAIN-world bridge runs in the page and is not a cryptographically trusted channel: page scripts can observe or forge its messages. Validation and request matching do not authenticate the page. Restoration uses the supplied share URL and verified resolver results, never inference from nearby posts or page DOM. Popup and context-menu resolution remain explicit alternatives; a prefetched result can also serve a later supported `copy` event.

The resolver follows HTTP redirects without credentials or referrer and accepts a successful HTML response whose final URL is an exact HTTPS Threads post URL. It validates the final destination, not every intermediate hop. A non-redirected share response must contain unambiguous canonical metadata. Network errors, login destinations and unverified results preserve the original share URL. Rich clipboard data is passed through unchanged. Automatic cleaning being off prevents automatic Threads requests; manual actions remain available. LinkSweep cannot guarantee removal of every tracking parameter or coordinate with external clipboard writers. Address-bar cleanup occurs after the initial request and does not undo tracking already received by the destination.

## Tests

Run from the repository root with the standard library only:

```bash
node --test *.test.cjs
python3 -m unittest test_rules.py
```

`settings.test.cjs` covers the serialized settings migration and `pasteClean` gating in `background.js`, the offscreen MIME handling and generation guards, and background message validation using simulated popup senders via `node:vm`. Browser integration is covered separately below.

### Browser E2E

Requires Python 3.10+. Install into an isolated environment once:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r e2e/requirements.txt
.venv/bin/python -m playwright install chromium
```

Rebuild before each run:

```bash
python3 -B build_copy_rules.py
python3 -B build_navigation_bundle.py
.venv/bin/python -B -m pytest e2e/ -q --junitxml=e2e-results/results.xml
```

Set `LINKSWEEP_HEADED=1` for a visible browser. Each run uses a temporary profile, removed on exit; personal Chrome data is not loaded. Tests write to the browser's native clipboard. Visible mode may overwrite the system clipboard: save important contents first and avoid concurrent copying.

The 20 offline E2E cases exercise native text/ClipboardItem writes, rich-format preservation, keyboard copy, functional/signed parameters, actual click request URLs, window.open, popup manual copying and stale-input protection, master settings, passive plain-text cleaning and rich-text preservation, opt-in persistence, and legacy settings migration. Deterministic service-worker `fetch` mocks additionally cover delayed verified Threads resolution, successful commitment of the original pending write, cancellation by newer plain/rich writes, disable cancellation, and timeout preservation. These use the real native clipboard and extension bridge, not mocked clipboard APIs. JUnit XML is generated; fixture-page failures also save screenshots and page errors under `e2e-results/`.

The server binds only to loopback. Nonlocal DNS and page requests are blocked, including test Threads URLs. Mocked resolver responses verify automatic restoration and cancellation offline, not live Threads behaviour; nearby-post tests verify there is no wrong-post inference. Toolbar popup UI, OS context menus, and real login/checkout flows still require manual validation; popup E2E opens the extension's popup.html as a page.

Reported validation: 20 offline E2E cases passed and 132 JavaScript tests passed; the parent task's final check is still pending.

Initiator exceptions retain domain=/from= source semantics. Page copying/navigation supplies the current source URL; popup/manual/background clipboard operations with unknown sources conservatively retain applicable exceptions, so some UTM parameters may remain in those paths.

### Optional live Threads check

This contacts the real site, separately from the offline suite. It uses an isolated profile, cleans through the popup, clicks Copy, and asserts the native clipboard matches the supplied expectation. JSON and screenshot evidence are saved under `e2e-results/threads-live.*`.

```bash
python3 -B e2e/threads_live.py --allow-network --url "https://www.threads.com/share/DinjQipPA/" --expected "https://threads.com/@ioichon/post/DdYKhJvk0rW"
```

This popup case passed in Chrome for Testing 148 with an observed 302 redirect. It verifies popup resolution and copying only.

To separately observe the site's Copy Link UI, with an explicitly labeled test harness only if that action is unavailable, run:

```bash
.venv/bin/python -B e2e/threads_copy_live.py --allow-network --page-url "https://www.threads.com/@ioichon/post/DdYKhJvk0rW" --url "https://www.threads.com/share/DinjQipPA/" --expected "https://threads.com/@ioichon/post/DdYKhJvk0rW" --harness-if-unavailable --artifact-prefix threads-copy-live
```

`--page-url`, `--url` and `--expected` are required; `--allow-network` explicitly permits real-site requests. Omit `--harness-if-unavailable` to observe only the site's own action. The script requires an existing `e2e-results/` directory and uses an isolated, logged-out Chromium profile. `--artifact-prefix` controls both the JSON report (`e2e-results/threads-copy-live.json` by default) and screenshots (`e2e-results/threads-copy-live-initial.png`, `threads-copy-live-native.png`, and, when applicable, `threads-copy-live-harness.png` or `threads-copy-live-error.png` in the same directory). Prefixes may contain only letters, digits, underscores and hyphens; there is no separate report-path option.

The live observation encountered a login wall: **Threads' own Copy Link button was not verified**. The labeled harness on the real site successfully restored the supplied share URL on retry using the real bridge, resolver and native clipboard; it was not a native Threads action. The first attempt timed out during resolution and correctly preserved the original share URL, so its expected-restoration assertion failed. Evidence is retained separately in `e2e-results/threads-copy-live.json` and `e2e-results/threads-copy-live-retry.json`, with matching screenshot prefixes. Clipboard readback used an extension page because the Threads page's permissions policy blocked reading; the write originated on the Threads page. A harness pass must not be treated as verification of the site's own button.

## License

LinkSweep's original extension code is released under **GNU General Public License v3.0**; see [`LICENSE`](LICENSE). Bundled third-party rule data retains its upstream license: ClearURLs Rules is LGPL-3.0, while the bundled AdGuard and uBlock rule data is GPL-3.0. See [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing individual files or generated data.

[1]: https://github.com/ClearURLs/Addon/ "ClearURLs Addon"
[2]: https://github.com/ClearURLs/Rules "ClearURLs Rules"
[3]: https://github.com/AdguardTeam/AdGuardFilters "AdGuard Filters"
[4]: https://github.com/uBlockOrigin/uAssets "uBlock Origin uAssets"
