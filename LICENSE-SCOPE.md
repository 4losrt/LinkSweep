# License scope

本 repository 的根目錄 `LICENSE` 是 **GNU General Public License version 3.0**，適用於 LinkSweep 的自有程式碼，包括 service worker、content scripts、Popup、Threads resolver integration、build scripts、測試程式與本專案自行撰寫的文件內容，除非個別檔案另有說明。

本 repository 也包含第三方資料快照與由其產生的資料。這些檔案不因根目錄 LICENSE 而失去上游授權與 attribution 要求：

| 範圍 | 檔案 | 授權／說明 |
|---|---|---|
| ClearURLs 規則資料 | `vendor/clearurls_data.minify.json`、`rules.js` 中的 ClearURLs provider data | GNU LGPL v3；詳見 `vendor/LICENSE-ClearURLs-Rules.txt`。 |
| AdGuard URL Tracking filter 快照與轉換結果 | `vendor/adguard_url_tracking_filter.txt`、`rules.js` 中的 converted rules | GNU GPL v3；詳見 `vendor/LICENSE-AdGuardFilters.txt`。 |
| uBlock Origin Privacy filter 快照與轉換結果 | `vendor/ublock_privacy.txt`、`rules.js` 中的 converted rules | GNU GPL v3；詳見 `vendor/LICENSE-uBlockOrigin-uAssets.txt`。 |
| LinkSweep icon | `img/icon_16.png`、`img/icon_48.png`、`img/icon_128.png` | LinkSweep 專案資產；不屬於上述三個上游專案。 |

`rules.js` 是混合生成資料，不能只以其中一個上游授權概括。請同時閱讀 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)、各 vendor license file 與 [`SOURCE-NOTICES.md`](SOURCE-NOTICES.md)。

這份文件是 repository 的授權範圍說明，不是對任何特定散布形式的法律意見。若要以不同授權重新發布、只散布 bundle、或將本專案整合到其他產品，請依實際檔案與散布方式進行授權審查。
