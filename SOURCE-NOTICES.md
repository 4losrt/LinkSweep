# Rule sources and notices

LinkSweep bundles and converts URL-cleaning data from three upstream projects. The extension code is maintained separately; this file describes only the bundled rule data and generated outputs.

| Source | Upstream project | Bundled snapshot | Generated output | License |
|---|---|---|---|---|
| ClearURLs provider rules | [ClearURLs/Rules][1], used by the [ClearURLs Addon][2] | `vendor/clearurls_data.minify.json` | ClearURLs provider portion of `rules.js` | GNU LGPL v3; see `vendor/LICENSE-ClearURLs-Rules.txt` |
| AdGuard URL Tracking filter | [AdguardTeam/AdGuardFilters][3] | `vendor/adguard_url_tracking_filter.txt` | Selected converted literal／bounded rules in `rules.js` | GNU GPL v3; see `vendor/LICENSE-AdGuardFilters.txt` |
| uBlock Origin Privacy filter | [uBlockOrigin/uAssets][4] | `vendor/ublock_privacy.txt` | Selected converted literal／bounded rules in `rules.js` | GNU GPL v3; see `vendor/LICENSE-uBlockOrigin-uAssets.txt` |

## Conversion boundary

`build_copy_rules.py` does not embed the AdGuard or uBlock filter engines. It imports only rules that can be represented conservatively by LinkSweep's URL query-parameter model: bounded literal parameters, bounded regular expressions and explicit host rules. It skips remove-all rules, complex path/query conditions, redirects, unsupported modifiers and patterns whose meaning cannot be preserved safely. Counts and skipped categories are recorded in `vendor/rules_conversion_stats.json`.

ClearURLs provider exceptions, special URL validation and LinkSweep's functional-parameter allowlists take precedence over supplementary tracking rules. YouTube video IDs, playlists, indexes and time parameters are protected by explicit tests. Threads share URLs are changed only after a public post URL is validated; otherwise the original URL remains unchanged.

## Attribution boundary

The upstream projects retain copyright and license rights in their respective data and code. LinkSweep does not embed the ClearURLs Addon application, the AdGuard filter engine or the uBlock Origin extension. LinkSweep includes snapshots and generated data because those projects provide established privacy URL rules; the generated file is a mixed data artifact and must be reviewed together with [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md).

## Snapshot metadata

The repository should record the upstream commit, release or retrieval date whenever vendor snapshots are refreshed. The current conversion inventory is stored in `vendor/rules_conversion_stats.json`, while source URLs, local filenames and known license scope are recorded in [`vendor/SOURCES.yml`](vendor/SOURCES.yml). Contributors must update those files and this notice when changing source snapshots.

[1]: https://github.com/ClearURLs/Rules "ClearURLs Rules"
[2]: https://github.com/ClearURLs/Addon/ "ClearURLs Addon"
[3]: https://github.com/AdguardTeam/AdGuardFilters "AdGuard Filters"
[4]: https://github.com/uBlockOrigin/uAssets "uBlock Origin uAssets"
