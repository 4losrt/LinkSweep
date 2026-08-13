(() => {
    "use strict";

    const POLL_MS = 1500;
    const THREADS_RETRY_MS = 8000;
    const DEFAULT_SETTINGS = {
        enabled: true,
        pasteClean: true,
        referralMarketing: false
    };

    let settings = {...DEFAULT_SETTINGS};
    let timer = null;
    let lastClipboardText = null;
    let lastAttemptAt = 0;
    let retryLastValue = false;
    let busy = false;

    function isMonitoringEnabled() {
        return Boolean(settings.enabled && settings.pasteClean);
    }

    function cleaningData() {
        return {
            ...CLEAN_URLS_RULES,
            enabled: true,
            referralMarketing: Boolean(settings.referralMarketing)
        };
    }

    function stopPolling() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    }

    function startPolling() {
        stopPolling();
        if (!isMonitoringEnabled()) return;
        timer = setInterval(() => pollClipboard().catch(() => {}), POLL_MS);
        pollClipboard().catch(() => {});
    }

    async function readClipboard() {
        try {
            return await navigator.clipboard.readText();
        } catch (error) {
            return null;
        }
    }

    async function resolveForClipboard(value) {
        if (window.CleanURLsSpecial && CleanURLsSpecial.isThreadsShareURL(value)) {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: "cleanClipboardURL",
                    url: value
                });
                if (!response || typeof response !== "object") {
                    return {input: value, output: value, changed: false, safe: false, removed: []};
                }
                const output = typeof response.output === "string" ? response.output : value;
                return {
                    ...response,
                    input: value,
                    output,
                    changed: Boolean(response.safe && output !== value),
                    safe: Boolean(response.safe),
                    removed: Array.isArray(response.removed) ? response.removed : []
                };
            } catch (error) {
                return {input: value, output: value, changed: false, safe: false, removed: []};
            }
        }
        return CleanURLs.cleanURL(value, cleaningData());
    }

    async function writeIfStillCurrent(before, after) {
        if (!isMonitoringEnabled() || !after || !after.safe || !after.changed
            || !CleanURLs.isURL(after.output) || after.output === before) return false;

        // Do not overwrite a newer clipboard value while a Threads request is pending.
        const current = await readClipboard();
        if (current === null || CleanURLs.extractSingleURL(current) !== before) return false;
        try {
            await navigator.clipboard.writeText(after.output);
            lastClipboardText = after.output;
            await chrome.runtime.sendMessage({
                type: "clipboardCleaned",
                before,
                after: after.output,
                removed: Array.isArray(after.removed) ? after.removed : [],
                resolved: Boolean(after.resolved)
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    async function pollClipboard() {
        if (busy || !isMonitoringEnabled()) return;
        busy = true;
        try {
            const text = await readClipboard();
            if (text === null) return;
            const value = CleanURLs.extractSingleURL(text);
            if (!value) {
                lastClipboardText = text;
                return;
            }
            const now = Date.now();
            if (value === lastClipboardText) {
                const retryAllowed = retryLastValue && now - lastAttemptAt >= THREADS_RETRY_MS;
                if (!retryAllowed) return;
            }
            lastClipboardText = value;
            lastAttemptAt = now;
            retryLastValue = false;

            const result = await resolveForClipboard(value);
            const wrote = await writeIfStillCurrent(value, result);
            if (!wrote && window.CleanURLsSpecial && CleanURLsSpecial.isThreadsShareURL(value)) {
                retryLastValue = true;
            }
        } finally {
            busy = false;
        }
    }

    function applySettings(next) {
        settings = {...settings, ...(next || {})};
        if (isMonitoringEnabled()) startPolling();
        else stopPolling();
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.type !== "offscreenConfigure") return;
        applySettings(message.settings);
        sendResponse({ok: true, monitoring: isMonitoringEnabled()});
    });

    // The offscreen document may not expose extension storage in all Chrome
    // versions. The service worker is the single source of truth and sends
    // settings after this ready signal.
    chrome.runtime.sendMessage({type: "offscreenReady"}).catch(() => {});
})();
