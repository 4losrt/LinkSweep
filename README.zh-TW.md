# LinkSweep — Clean URLs

[English README](README.md)

> **製作署名：本專案由 Manus 協助完成，包括功能設計、Manifest V3 實作、測試、授權整理與 GitHub 文件準備。**

LinkSweep 是一個 Chrome Manifest V3 擴充功能，專門清理複製與開啟的 URL。只有在能確認結果安全時才會移除追蹤參數，同時保留 YouTube 影片 ID、播放清單、索引、時間戳與其他內容識別碼等功能性參數。

## 功能

| 功能 | 行為 |
|---|---|
| 複製清理 | 清理可攔截 `copy` event 中的 URL。 |
| 程式化 Clipboard 清理 | 保守處理 `navigator.clipboard.writeText()` 與 `navigator.clipboard.write(ClipboardItem[])`；失敗時原樣放行。 |
| 被動剪貼簿監控 | 兩個開關都開啟時，由 MV3 offscreen document 約每 1.5 秒檢查單一 URL；只有安全且確實不同才寫回。 |
| 點擊／開啟清理 | 在支援的連結點擊、`window.open` 與部分導覽路徑開啟前清理。 |
| Threads 還原 | 能驗證時將 `/share/XXXX/` 轉成 `/@username/post/POST_ID`；無法驗證時保持不變。 |
| YouTube 保護 | 保留影片、播放清單、索引、時間與其他功能參數，只移除已知追蹤參數。 |
| 手動備用清理 | 即使自動清理關閉，仍可使用 Popup 與右鍵選單明確清理。 |

## 在 Chrome 安裝

1. 下載並解壓縮本 repository。
2. 開啟 `chrome://extensions`。
3. 開啟「開發人員模式」。
4. 選擇「載入未封裝項目」。
5. 指定包含 `manifest.json` 的解壓縮資料夾。
6. 重新載入擴充功能，並重新整理已經開啟的網頁。

Popup 有兩個控制項。**自動清理**是總開關，控制自動複製、Clipboard、點擊與開啟清理。**被動剪貼簿清理**只控制 offscreen 剪貼簿監控。即使自動功能關閉，Popup 手動清理仍可明確執行一次。

## 保守行為

LinkSweep 不會修改一般文字、多行剪貼簿內容、格式錯誤的 URL 或無法驗證的特殊網址。Threads 還原可能受到 redirect、登入牆、CORS、HTTP 429、網路限制或網站 DOM 改版影響。遇到這些情況時，LinkSweep 會採取 fail closed 策略，保留原始 `/share/XXXX/`，不猜測貼文 ID。

## 隱私與權限

LinkSweep 沒有帳戶系統、分析端點或維護者管理的上傳服務。剪貼簿內容在本機處理。Threads resolver 可能請求正在解析的公開 URL，以驗證 redirect 或公開 metadata。

| 權限 | 用途 |
|---|---|
| `storage` | 儲存開關、計數器與最後一次清理紀錄。 |
| `clipboardRead` | 僅供選用的被動 URL 清理監控讀取剪貼簿。 |
| `clipboardWrite` | 只有結果安全且不同時寫回。 |
| `offscreen` | 在 MV3 中提供可使用 Clipboard DOM API 的隱藏 document。 |
| `contextMenus` | 提供右鍵手動清理。 |
| `scripting` | 支援明確的右鍵複製操作。 |
| `<all_urls>` host permission | 讓複製與導覽處理可跨網站運作；不代表會收集瀏覽紀錄。 |

## 規則來源

封裝的 `rules.js` 包含 LinkSweep 程式碼，以及從 [ClearURLs Addon][1]／[ClearURLs Rules][2]、[AdGuard Filters][3] 與 [uBlock Origin uAssets][4] 選取並保守轉換的資料。LinkSweep 不包含 AdGuard 或 uBlock 的完整 filter engine。無法安全保留語意的 redirect、remove-all、複雜 modifier 與複雜規則會被跳過。

規則來源的授權與 attribution 記錄在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)、[`SOURCE-NOTICES.md`](SOURCE-NOTICES.md)、[`LICENSE-SCOPE.md`](LICENSE-SCOPE.md) 與 `vendor/` 內的授權檔案。

## 選用的重新建置

封裝內的 `rules.js` 與 `navigation_main_bundle.js` 已可直接載入。如果修改來源程式或 vendor snapshots，可使用以下指令重新產生：

```bash
python3 build_copy_rules.py
python3 build_navigation_bundle.py
```

## 授權

LinkSweep 自有擴充功能程式碼採用 **GNU General Public License v3.0**，詳見 [`LICENSE`](LICENSE)。內含的第三方規則資料保留上游授權：ClearURLs Rules 為 LGPL-3.0；AdGuard 與 uBlock 規則資料為 GPL-3.0。重新散布個別檔案或生成資料前，請閱讀 [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md) 與 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

[1]: https://github.com/ClearURLs/Addon/ "ClearURLs Addon"
[2]: https://github.com/ClearURLs/Rules "ClearURLs Rules"
[3]: https://github.com/AdguardTeam/AdGuardFilters "AdGuard Filters"
[4]: https://github.com/uBlockOrigin/uAssets "uBlock Origin uAssets"
