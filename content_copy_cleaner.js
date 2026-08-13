(() => {
    "use strict";

    const DEFAULT_SETTINGS = {
        enabled: true,
        pasteClean: true,
        referralMarketing: false
    };
    let settings = {...DEFAULT_SETTINGS};
    const specialCache = new Map();
    const specialPending = new Set();

    function broadcastNavigationSettings() {
        window.postMessage({
            source: "clean-urls-copy",
            type: "settings",
            enabled: Boolean(settings.enabled),
            pasteClean: Boolean(settings.pasteClean),
            referralMarketing: Boolean(settings.referralMarketing)
        }, "*");
    }

    function loadSettings() {
        return chrome.storage.local.get(DEFAULT_SETTINGS)
            .then(result => {
                settings = {...DEFAULT_SETTINGS, ...result};
                broadcastNavigationSettings();
                return settings;
            })
            .catch(() => {
                broadcastNavigationSettings();
                return settings;
            });
    }

    function selectedText() {
        const selection = window.getSelection();
        return selection ? selection.toString().trim() : "";
    }

    function closestAnchor(node) {
        const element = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        return element && element.closest ? element.closest("a[href], area[href]") : null;
    }

    function extractCandidate(event) {
        const selected = selectedText();
        const selectedURL = CleanURLs.extractSingleURL(selected);
        if (selectedURL) {
            return {url: selectedURL, source: "selection"};
        }

        const selection = window.getSelection();
        const anchor = closestAnchor(selection && selection.anchorNode)
            || closestAnchor(event.target)
            || (document.activeElement && closestAnchor(document.activeElement));
        if (!anchor || selected) return null;

        const href = CleanURLs.extractLinkURL(anchor);
        if (!href) return null;
        return {url: href, source: "anchor"};
    }

    function isWritableCopyEvent(event) {
        return Boolean(event && event.cancelable && event.clipboardData
            && typeof event.clipboardData.setData === "function");
    }

    function cacheSpecialResult(result) {
        if (!result || !result.input) return;
        specialCache.set(result.input, result);
        window.postMessage({
            source: "clean-urls-copy",
            type: "resolved-cache",
            input: result.input,
            output: result.output,
            safe: Boolean(result.safe),
            resolved: Boolean(result.resolved),
            removed: Array.isArray(result.removed) ? result.removed : []
        }, "*");
    }

    function prefetchSpecialURL(value) {
        if (!window.CleanURLsSpecial || !CleanURLsSpecial.isThreadsShareURL(value)) return;
        if (specialCache.has(value) || specialPending.has(value)) return;
        specialPending.add(value);
        chrome.runtime.sendMessage({type: "resolveSpecialURL", url: value})
            .then(result => {
                specialPending.delete(value);
                if (result) cacheSpecialResult(result);
            })
            .catch(() => specialPending.delete(value));
    }

    function notifyBackground(result, source) {
        chrome.runtime.sendMessage({
            type: "copyCleaned",
            before: result.input,
            after: result.output,
            removed: result.removed,
            source
        }).catch(() => {});
    }

    function isTrustedCommittedPair(input, output, resolved = false) {
        if (!CleanURLs.isURL(input) || !CleanURLs.isURL(output)) return false;
        if (window.CleanURLsSpecial && CleanURLsSpecial.isThreadsShareURL(input)) {
            return Boolean(resolved && CleanURLsSpecial.isThreadsPostURL(output));
        }
        const local = CleanURLs.cleanURL(input, {
            ...CLEAN_URLS_RULES,
            enabled: true,
            referralMarketing: Boolean(settings.referralMarketing)
        });
        return Boolean(local.safe && local.changed && local.output === output);
    }

    function sendClipboardResponse(requestId, input, result) {
        const safe = Boolean(result && result.safe && CleanURLs.isURL(result.output));
        const output = safe ? result.output : input;
        window.postMessage({
            source: "clean-urls-copy",
            type: "clipboard-response",
            requestId,
            input,
            output,
            safe,
            changed: safe && output !== input,
            resolved: Boolean(result && result.resolved),
            removed: Array.isArray(result && result.removed) ? result.removed : []
        }, "*");
    }

    async function handleClipboardRequest(event) {
        const message = event && event.data;
        if (event.source !== window || !message
            || message.source !== "clean-urls-copy-navigation"
            || message.type !== "clipboard-request") return;
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        const input = typeof message.value === "string" ? message.value : "";
        if (!requestId || !CleanURLs.isURL(input) || !settings.enabled || !settings.pasteClean) {
            sendClipboardResponse(requestId, input, {
                input,
                output: input,
                safe: false,
                changed: false,
                removed: []
            });
            return;
        }
        try {
            const result = await chrome.runtime.sendMessage({type: "cleanClipboardURL", url: input});
            sendClipboardResponse(requestId, input, result);
        } catch (error) {
            sendClipboardResponse(requestId, input, {
                input,
                output: input,
                safe: false,
                changed: false,
                removed: []
            });
        }
    }

    function handleCopy(event) {
        if (event.defaultPrevented || !isWritableCopyEvent(event) || !settings.enabled) return;

        const candidate = extractCandidate(event);
        if (!candidate || !CleanURLs.isURL(candidate.url)) return;

        const data = {
            ...CLEAN_URLS_RULES,
            enabled: true,
            referralMarketing: Boolean(settings.referralMarketing)
        };
        const special = specialCache.get(candidate.url);
        const result = special && special.safe
            ? {
                input: candidate.url,
                output: special.output,
                changed: special.output !== candidate.url,
                safe: true,
                removed: Array.isArray(special.removed) ? special.removed : []
            }
            : CleanURLs.cleanURL(candidate.url, data);
        if (!result.changed || !result.safe || !CleanURLs.isURL(result.output)) return;

        try {
            const existingTypes = Array.from(event.clipboardData.types || []);
            event.clipboardData.setData("text/plain", result.output);
            if (candidate.source === "anchor" || existingTypes.includes("text/uri-list")) {
                event.clipboardData.setData("text/uri-list", result.output);
            }
            event.preventDefault();
            notifyBackground(result, candidate.source);
        } catch (error) {
            // If any write fails, do not cancel the browser's original copy.
        }
    }

    window.addEventListener("message", event => {
        if (event.source === window && event.data
            && event.data.source === "clean-urls-copy-navigation"
            && event.data.type === "clipboard-committed") {
            const before = typeof event.data.before === "string" ? event.data.before : "";
            const after = typeof event.data.after === "string" ? event.data.after : "";
            const resolved = Boolean(event.data.resolved);
            if (isTrustedCommittedPair(before, after, resolved)) {
                chrome.runtime.sendMessage({
                    type: "clipboardCleaned",
                    before,
                    after,
                    removed: Array.isArray(event.data.removed) ? event.data.removed : [],
                    resolved
                }).catch(() => {});
            }
        }
        handleClipboardRequest(event).catch(() => {});
    });
    document.addEventListener("copy", handleCopy, true);
    document.addEventListener("pointerover", event => {
        const anchor = closestAnchor(event.target);
        if (anchor && anchor.href) prefetchSpecialURL(anchor.href);
    }, true);
    document.addEventListener("focusin", event => {
        const anchor = closestAnchor(event.target);
        if (anchor && anchor.href) prefetchSpecialURL(anchor.href);
    }, true);
    document.addEventListener("selectionchange", () => {
        const value = selectedText();
        if (value) prefetchSpecialURL(value);
    });
    loadSettings();
    chrome.storage.onChanged.addListener(changes => {
        if (changes.enabled) settings.enabled = Boolean(changes.enabled.newValue);
        if (changes.pasteClean) settings.pasteClean = Boolean(changes.pasteClean.newValue);
        if (changes.referralMarketing) settings.referralMarketing = Boolean(changes.referralMarketing.newValue);
        broadcastNavigationSettings();
    });
})();
