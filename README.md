# LinkSweep — Clean URLs

[繁體中文 README](README.zh-TW.md)

> **Production credit:** This project was completed with assistance from Manus, including feature design, Manifest V3 implementation, testing, license organization, and GitHub documentation.

LinkSweep is a Chrome Manifest V3 extension for cleaning copied and opened URLs. It removes tracking parameters only when the result can be verified as safe, while preserving functional values such as YouTube video IDs, playlists, indexes, timestamps, and other content identifiers.

## [📥 Download Latest LinkSweep.crx](https://github.com/4losrt/LinkSweep/releases/latest/download/LinkSweep.crx)

## Features

| Feature | Behaviour |
|---|---|
| Copy cleaning | Cleans URLs from interceptable `copy` events. |
| Programmatic Clipboard cleaning | Conservatively handles `navigator.clipboard.writeText()` and `navigator.clipboard.write(ClipboardItem[])`; failures pass through unchanged. |
| Passive Clipboard monitoring | When both switches are enabled, an MV3 offscreen document checks single URL clipboard contents about every 1.5 seconds and writes back only a verified, changed result. |
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

The Popup has two controls. **Automatic cleaning** is the master switch for automatic copy, Clipboard, click, and open cleaning. **Passive Clipboard cleaning** controls only the offscreen Clipboard monitor. Manual Popup cleaning remains available as an explicit one-time action.

## Conservative behaviour

LinkSweep does not modify ordinary text, multi-line clipboard content, malformed URLs, or special URLs that cannot be verified. Threads resolution can be affected by redirects, login walls, CORS, HTTP 429 responses, network restrictions, or site DOM changes. In those cases LinkSweep uses a fail-closed strategy and keeps the original `/share/XXXX/` URL instead of guessing a post ID.

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

The packaged `rules.js` and `navigation_main_bundle.js` are ready to load. If you modify the source or vendor snapshots, regenerate them with:

```bash
python3 build_copy_rules.py
python3 build_navigation_bundle.py
```

## License

LinkSweep's original extension code is released under **GNU General Public License v3.0**; see [`LICENSE`](LICENSE). Bundled third-party rule data retains its upstream license: ClearURLs Rules is LGPL-3.0, while the bundled AdGuard and uBlock rule data is GPL-3.0. See [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing individual files or generated data.

[1]: https://github.com/ClearURLs/Addon/ "ClearURLs Addon"
[2]: https://github.com/ClearURLs/Rules "ClearURLs Rules"
[3]: https://github.com/AdguardTeam/AdGuardFilters "AdGuard Filters"
[4]: https://github.com/uBlockOrigin/uAssets "uBlock Origin uAssets"
