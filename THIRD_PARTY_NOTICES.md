# Third-party notices

LinkSweep contains original extension code and generated data derived from third-party URL-cleaning projects. The files and licenses below are intentionally listed separately from the root project license.

## 1. ClearURLs

LinkSweep uses a snapshot of ClearURLs provider and rule data in `vendor/clearurls_data.minify.json`; the generated provider rules are included in `rules.js`. The original ClearURLs ecosystem is maintained by [ClearURLs/Addon][1] and the rule database is maintained in [ClearURLs/Rules][2]. The bundled ClearURLs license text is [`vendor/LICENSE-ClearURLs-Rules.txt`](vendor/LICENSE-ClearURLs-Rules.txt), which is GNU Lesser General Public License version 3.

This project does **not** claim ownership of ClearURLs' provider data or the ClearURLs Addon code. LinkSweep's own MV3 service worker, content scripts, popup, resolver integration and build scripts are separate original code in this repository. ClearURLs attribution is retained here because its data is redistributed and transformed into the generated rules used by LinkSweep.

## 2. AdGuard Filters

LinkSweep includes a snapshot of the AdGuard URL Tracking filter in `vendor/adguard_url_tracking_filter.txt`. A selected, conservative subset is converted into `rules.js`; the complete AdGuard filter engine is not embedded. The bundled license text is [`vendor/LICENSE-AdGuardFilters.txt`](vendor/LICENSE-AdGuardFilters.txt), which is GNU General Public License version 3. The upstream project is [AdguardTeam/AdGuardFilters][3].

The converter intentionally skips rules that cannot be represented safely in LinkSweep's copy／click cleaning model. Therefore the generated `rules.js` is not a claim that LinkSweep implements the entire AdGuard filter syntax.

## 3. uBlock Origin / uAssets

LinkSweep includes a snapshot of the relevant uBlock Origin Privacy filter data in `vendor/ublock_privacy.txt`. A selected, conservative subset is converted into `rules.js`. The upstream project is [uBlockOrigin/uAssets][4], and the bundled license text is [`vendor/LICENSE-uBlockOrigin-uAssets.txt`](vendor/LICENSE-uBlockOrigin-uAssets.txt), which is GNU General Public License version 3.

LinkSweep does not embed the uBlock Origin extension or a uBlock filter engine. It uses only the converted URL-parameter rules described above.

## 4. Generated data and attribution boundary

`rules.js` is generated data containing provider rules from ClearURLs and selected converted rules from AdGuard and uBlock sources. Its exact conversion counts and skipped categories are recorded in `vendor/rules_conversion_stats.json`. Rebuilds should be performed with `build_copy_rules.py` so that changes to source snapshots remain auditable.

The LinkSweep icon is included under `img/`. It is a project asset and is not part of the ClearURLs, AdGuard or uBlock projects. Test screenshots, local browser logs, live HTML captures and release ZIP files are not required for the source distribution and should not be committed unless a release process specifically needs them.

## 5. Source links

[1]: https://github.com/ClearURLs/Addon/ "ClearURLs Addon"
[2]: https://github.com/ClearURLs/Rules "ClearURLs Rules"
[3]: https://github.com/AdguardTeam/AdGuardFilters "AdGuard Filters"
[4]: https://github.com/uBlockOrigin/uAssets "uBlock Origin uAssets"
