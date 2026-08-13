(() => {
    "use strict";

    const DEFAULT_SETTINGS = {
        enabled: true,
        pasteClean: true,
        referralMarketing: false,
        copiedCount: 0,
        pasteCleanedCount: 0,
        lastRemoved: [],
        lastCleanedBefore: "",
        lastCleanedAfter: "",
        lastCleanedAt: 0,
        lastCleanedSource: ""
    };

    const enabled = document.querySelector("#enabled");
    const pasteClean = document.querySelector("#pasteClean");
    const referralMarketing = document.querySelector("#referralMarketing");
    const masterCard = document.querySelector("#masterCard");
    const masterTitle = document.querySelector("#masterTitle");
    const masterDescription = document.querySelector("#masterDescription");
    const clipboardStatus = document.querySelector("#clipboardStatus");
    const input = document.querySelector("#input");
    const output = document.querySelector("#output");
    const cleanButton = document.querySelector("#clean");
    const copyButton = document.querySelector("#copy");
    const manualStatus = document.querySelector("#manualStatus");
    const lastEmpty = document.querySelector("#lastEmpty");
    const lastDetail = document.querySelector("#lastDetail");
    const lastSource = document.querySelector("#lastSource");
    const lastBefore = document.querySelector("#lastBefore");
    const lastAfter = document.querySelector("#lastAfter");
    const removedList = document.querySelector("#removedList");
    const lastTime = document.querySelector("#lastTime");

    let settings = {...DEFAULT_SETTINGS};

    function setStatus(element, message, error = false) {
        element.textContent = message;
        element.classList.toggle("is-error", error);
    }

    function renderMaster() {
        const on = Boolean(settings.enabled);
        enabled.checked = on;
        masterCard.classList.toggle("is-off", !on);
        masterTitle.textContent = on ? "自動清理已開啟" : "自動清理已關閉";
        masterDescription.textContent = on
            ? "複製與開啟連結時，只在安全確認後移除追蹤碼。"
            : "複製、點擊與被動剪貼簿清理都已暫停。手動清理仍可使用。";

        pasteClean.checked = Boolean(settings.pasteClean);
        pasteClean.disabled = !on;
        setStatus(
            clipboardStatus,
            !on
                ? "總開關關閉中；啟用後才會監控剪貼簿。"
                : settings.pasteClean
                    ? "監控已啟用：只處理單一 http(s) URL。"
                    : "監控已停用：剪貼簿不會被讀取或改寫。"
        );
        referralMarketing.checked = Boolean(settings.referralMarketing);
    }

    function sourceLabel(source) {
        return {
            clipboard: "剪貼簿",
            copy: "複製事件",
            anchor: "複製連結",
            context: "右鍵選單",
            "context-menu": "右鍵選單"
        }[source] || "自動清理";
    }

    function formatTime(timestamp) {
        if (!timestamp) return "";
        try {
            return new Intl.DateTimeFormat("zh-TW", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            }).format(new Date(timestamp));
        } catch (error) {
            return new Date(timestamp).toLocaleString();
        }
    }

    function renderLastCleaning() {
        const hasRecord = Boolean(settings.lastCleanedBefore && settings.lastCleanedAfter);
        lastEmpty.hidden = hasRecord;
        lastDetail.hidden = !hasRecord;
        lastSource.textContent = hasRecord ? sourceLabel(settings.lastCleanedSource) : "尚無紀錄";
        if (!hasRecord) return;

        lastBefore.textContent = settings.lastCleanedBefore;
        lastAfter.textContent = settings.lastCleanedAfter;
        lastTime.textContent = settings.lastCleanedAt
            ? `${formatTime(settings.lastCleanedAt)} · 已安全改寫剪貼簿／連結`
            : "";
        removedList.replaceChildren();
        const removed = Array.isArray(settings.lastRemoved) ? settings.lastRemoved : [];
        if (!removed.length) {
            const chip = document.createElement("span");
            chip.className = "chip neutral";
            chip.textContent = "特殊連結已解析";
            removedList.appendChild(chip);
            return;
        }
        for (const name of removed.slice(0, 8)) {
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.textContent = name;
            removedList.appendChild(chip);
        }
        if (removed.length > 8) {
            const chip = document.createElement("span");
            chip.className = "chip neutral";
            chip.textContent = `+${removed.length - 8}`;
            removedList.appendChild(chip);
        }
    }

    function render() {
        renderMaster();
        renderLastCleaning();
    }

    async function load() {
        settings = {...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS))};
        render();
    }

    async function setSetting(key, value) {
        settings = {...settings, [key]: value};
        render();
        await chrome.storage.local.set({[key]: value});
    }

    enabled.addEventListener("change", () => {
        setSetting("enabled", enabled.checked).catch(() => setStatus(clipboardStatus, "設定未能儲存。", true));
    });

    pasteClean.addEventListener("change", () => {
        setSetting("pasteClean", pasteClean.checked).catch(() => setStatus(clipboardStatus, "設定未能儲存。", true));
    });

    referralMarketing.addEventListener("change", () => {
        setSetting("referralMarketing", referralMarketing.checked).catch(() => {});
    });

    cleanButton.addEventListener("click", async () => {
        const value = input.value.trim();
        output.value = "";
        copyButton.disabled = true;
        if (!CleanURLs.isURL(value)) {
            setStatus(manualStatus, "請輸入一個有效的 http(s) URL。", true);
            return;
        }

        let result;
        try {
            result = await chrome.runtime.sendMessage({type: "cleanURL", url: value, manual: true});
        } catch (error) {
            result = CleanURLs.cleanURL(value, {
                ...CLEAN_URLS_RULES,
                enabled: true,
                referralMarketing: Boolean(settings.referralMarketing)
            });
        }
        if (!result || !result.safe || !CleanURLs.isURL(result.output)) {
            output.value = value;
            setStatus(manualStatus, "無法安全確認，已保留原始 URL。", true);
            return;
        }

        output.value = result.output;
        copyButton.disabled = false;
        if (result.resolved && result.changed) {
            setStatus(manualStatus, `Threads 連結已還原並清理：${(result.removed || []).join(", ") || "特殊分享參數"}`);
        } else if (result.resolved) {
            setStatus(manualStatus, "Threads 連結已還原，沒有其他可安全移除的參數。就緒後可複製。 ");
        } else if (result.changed) {
            setStatus(manualStatus, `已清理：${(result.removed || []).join(", ") || "追蹤參數"}`);
        } else {
            setStatus(manualStatus, "沒有找到可安全移除的追蹤碼。就緒後可複製。");
        }
    });

    copyButton.addEventListener("click", async () => {
        if (!output.value) return;
        try {
            await navigator.clipboard.writeText(output.value);
            setStatus(manualStatus, "已複製清理後的 URL。被動監控不會重複改寫它。");
        } catch (error) {
            setStatus(manualStatus, "瀏覽器未允許寫入剪貼簿。", true);
        }
    });

    chrome.storage.onChanged.addListener(changes => {
        for (const [key, change] of Object.entries(changes)) {
            settings[key] = change.newValue;
        }
        render();
    });

    load().catch(() => setStatus(clipboardStatus, "無法載入 LinkSweep 設定。", true));
})();
