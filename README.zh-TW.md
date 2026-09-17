# LinkSweep — Clean URLs

[English README](README.md)

> **製作署名：本專案由 Manus 協助完成，包括功能設計、Manifest V3 實作、測試、授權整理與 GitHub 文件準備。**

LinkSweep 是一個 Chrome Manifest V3 擴充功能，專門清理複製與開啟的 URL。只有在能確認結果安全時才會移除追蹤參數，同時保留 YouTube 影片 ID、播放清單、索引、時間戳與其他內容識別碼等功能性參數。

## 功能

| 功能 | 行為 |
|---|---|
| 複製清理 | 清理可攔截 `copy` event 中的 URL。 |
| 程式化 Clipboard 清理 | 清理 `navigator.clipboard.writeText()` 與單一、僅含 `text/plain` 的 ClipboardItem 寫入，包括經驗證的 Threads 分享網址自動還原。混合 MIME 與富文字項目原樣保留；取消與 API 限制見下文。 |
| 被動剪貼簿監控 | 預設關閉，升級時也會先停用一次。明確開啟後，由 MV3 offscreen document 約每 1.5 秒以 `navigator.clipboard.read()` 讀取剪貼簿，僅處理單一且只含 `text/plain` 的項目；只有安全且確實不同的純 URL 才寫回。富文字（HTML、圖片、多重表示）與多行或一般文字一律原樣保留。最後檢查與寫入之間仍存在極短的競態視窗；無法接受者請保持關閉。 |
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

Popup 有兩個控制項。**自動清理**是總開關，控制自動複製、Clipboard、點擊與開啟清理。**被動剪貼簿清理**只控制 offscreen 剪貼簿監控，預設關閉；升級時先前已儲存的開啟狀態會被停用一次，需重新自行開啟。Popup 手動清理仍是明確動作：只會複製由 LinkSweep 自己清理並驗證過的 URL，且不保證所有追蹤參數都已移除。

## 保守行為

LinkSweep 不會修改一般文字、多行剪貼簿內容、格式錯誤的 URL 或無法驗證的特殊網址。Threads 還原可能受到 redirect、登入牆、CORS、HTTP 429、網路限制或公開 canonical metadata 變更影響。遇到這些情況時，LinkSweep 會採取 fail closed 策略，保留原始 `/share/XXXX/`，不猜測貼文 ID。

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

封裝內的 `rules.js` 與 `navigation_main_bundle.js` 已可直接載入。修改原始碼或 vendor 快照後，請在 repository 根目錄重新建置：

```bash
python3 -B build_copy_rules.py
python3 -B build_navigation_bundle.py
```

## 僅使用 extension 與限制

使用本版前，請自行停用 LinkSweep 的 Tampermonkey 腳本；extension 不會替你停用 userscript。一般 `writeText()` 網址在本機清理，立即呼叫原生寫入。開啟自動清理時，透過 `writeText()` 或單一、僅含 `text/plain` 的 ClipboardItem 複製 Threads `/share/`，會立即呼叫原生 `clipboard.write()`，並以 ClipboardItem 中的 Promise 提供 Blob。經驗證的 resolver 為同一次寫入提供內容，不會延遲發起第二次寫入。解析無法驗證或等待內容超過六秒時，使用原始分享網址。所需 API 不可用時，原始寫入原樣放行。

同一 frame 中較新的受攔截寫入（包括一般文字或富文字），或關閉自動清理，會取消尚未 settled 的內容 Promise，並使待處理寫入遭拒。內容 Promise 一旦 settled，LinkSweep 就無法撤回原生提交。其他 frame、預先保留的未包裝 API 參照或外部應用程式寫入，不在順序保證範圍內。混合 MIME、富文字與多項目寫入原樣保留。

MAIN world bridge 在頁面內執行，不是具有密碼學信任保證的通道：頁面腳本可以觀察或偽造訊息。格式驗證與請求配對不等於驗證頁面身分。還原使用傳入的分享網址與經驗證的 resolver 結果，絕不從附近貼文或頁面 DOM 推測。Popup 與右鍵選單仍可明確手動解析；預先解析的結果也可用於後續支援的 `copy` event。

解析器不帶憑證或 referrer 跟隨 HTTP redirect，只接受成功 HTML 回應的最終 URL 為精確 HTTPS Threads 貼文網址；驗證的是最終目的地，並非逐一限制中間跳轉。沒有 redirect 的分享頁仍須提供無歧義的 canonical metadata。網路錯誤、登入頁或無法驗證時保留原分享網址。富文字剪貼簿原樣保留；關閉自動清理會停止自動 Threads 請求，手動操作仍可使用。無法保證移除每個追蹤參數，亦無法與外部剪貼簿寫入者協調。網址列清理發生在初次請求之後，不能撤回目的網站已收到的追蹤資料。

## 測試

請在 repository 根目錄以標準函式庫執行：

```bash
node --test *.test.cjs
python3 -m unittest test_rules.py
```

`settings.test.cjs` 涵蓋序列化的設定遷移與 `background.js` 的 `pasteClean` 閘門、offscreen 的 MIME 處理與 generation guard，以及透過 `node:vm` 模擬 Popup sender 的背景訊息驗證。瀏覽器整合另由下列 E2E 測試驗證。

### 瀏覽器實測

需要 Python 3.10+。首次在獨立虛擬環境安裝：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r e2e/requirements.txt
.venv/bin/python -m playwright install chromium
```

每次重跑：

```bash
python3 -B build_copy_rules.py
python3 -B build_navigation_bundle.py
.venv/bin/python -B -m pytest e2e/ -q --junitxml=e2e-results/results.xml
```

預設 headless；加上 `LINKSWEEP_HEADED=1` 可顯示測試瀏覽器。使用暫存設定檔並於結束移除，不載入個人 Chrome 資料；測試會寫入測試瀏覽器的原生剪貼簿。可見視窗模式可能改動系統剪貼簿，請先保存重要內容，且執行期間不要操作剪貼簿。

20 項離線 E2E 涵蓋 writeText、純文字 ClipboardItem、富文字保留、真實鍵盤複製、功能／簽名參數、點擊的實際請求、window.open、Popup 手動複製與失效保護、總開關、offscreen 純文字清理與富文字保留、選用設定持久化及舊設定遷移。確定性的 service worker `fetch` mock 另涵蓋延遲的 Threads 驗證解析、原待處理寫入成功提交、較新的一般文字／富文字寫入取消舊內容、關閉自動清理取消，以及逾時保留原網址。這些測試使用真正的原生剪貼簿與 extension bridge，並未 mock 剪貼簿 API。產出 JUnit XML；fixture 頁失敗時另存截圖及 pageerror 到 `e2e-results/`。

測試伺服器僅監聽 loopback，測試瀏覽器阻擋非本機網域解析及頁面請求；不會把測試 Threads 連結送到真站。模擬的 resolver 回應驗證離線自動還原與取消，不代表真站 Threads 行為；附近貼文案例驗證不會猜錯篇。Chrome 工具列彈出視窗、OS 右鍵選單、真實登入／購物流程仍需人工測試；Popup E2E 是直接開啟 extension 的 `popup.html`。

已回報的驗證結果：20 項離線 E2E 與 132 項 JavaScript 測試通過；父任務的最終檢查仍待完成。

帶 `domain=`／`from=` 的例外保留來源網站語意。一般網頁複製／點擊提供來源 URL；Popup、右鍵手動輸入與背景剪貼簿來源未知時採保守保留，因此部分 `utm_*` 在這些路徑仍可能保留。

### 選用真站測試

此命令會實際連線 Threads，不包含在預設離線測試中。使用獨立設定檔，透過 Popup 清理、按下複製並讀回剪貼簿，斷言與預期網址相同；結果與截圖在 `e2e-results/threads-live.json`、`e2e-results/threads-live.png`。

```bash
python3 -B e2e/threads_live.py --allow-network --url "https://www.threads.com/share/DinjQipPA/" --expected "https://threads.com/@ioichon/post/DdYKhJvk0rW"
```

此 Popup 案例已在 Chrome for Testing 148 驗證 302 導向、Popup 還原與複製成功，僅驗證 Popup 路徑。

若要另外觀察網站的「複製連結」UI，並僅在該操作不可用時使用明確標示的測試 harness，請執行：

```bash
.venv/bin/python -B e2e/threads_copy_live.py --allow-network --page-url "https://www.threads.com/@ioichon/post/DdYKhJvk0rW" --url "https://www.threads.com/share/DinjQipPA/" --expected "https://threads.com/@ioichon/post/DdYKhJvk0rW" --harness-if-unavailable --artifact-prefix threads-copy-live
```

`--page-url`、`--url` 與 `--expected` 為必填；`--allow-network` 明確允許真站請求。省略 `--harness-if-unavailable` 即只觀察網站自己的操作。腳本要求 `e2e-results/` 已存在，並使用獨立、未登入的 Chromium 設定檔。`--artifact-prefix` 同時控制 JSON 報告（預設 `e2e-results/threads-copy-live.json`）與截圖（`e2e-results/threads-copy-live-initial.png`、`threads-copy-live-native.png`，以及適用時同目錄下的 `threads-copy-live-harness.png` 或 `threads-copy-live-error.png`）。前綴僅可包含英文字母、數字、底線及連字號；沒有獨立的報告路徑選項。

真站觀察遇到登入牆：**尚未驗證 Threads 自己的「複製連結」按鈕**。在真站頁面上明確標示的 harness，於重試時透過真正的 bridge、resolver 與原生剪貼簿成功還原指定分享網址；這不是 Threads 原生操作。首次嘗試在解析時逾時，正確保留原始分享網址，因此預期還原的斷言失敗。兩次證據分別保留於 `e2e-results/threads-copy-live.json` 與 `e2e-results/threads-copy-live-retry.json`，截圖使用各自對應的前綴。因 Threads 頁面的 permissions policy 阻擋讀取，剪貼簿讀回改由 extension 頁面執行；寫入仍源自 Threads 頁面。harness 通過不可視為網站自身按鈕已驗證。

## 授權

LinkSweep 自有擴充功能程式碼採用 **GNU General Public License v3.0**，詳見 [`LICENSE`](LICENSE)。內含的第三方規則資料保留上游授權：ClearURLs Rules 為 LGPL-3.0；AdGuard 與 uBlock 規則資料為 GPL-3.0。重新散布個別檔案或生成資料前，請閱讀 [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md) 與 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

[1]: https://github.com/ClearURLs/Addon/ "ClearURLs Addon"
[2]: https://github.com/ClearURLs/Rules "ClearURLs Rules"
[3]: https://github.com/AdguardTeam/AdGuardFilters "AdGuard Filters"
[4]: https://github.com/uBlockOrigin/uAssets "uBlock Origin uAssets"
