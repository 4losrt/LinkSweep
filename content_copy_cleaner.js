(() => {
    "use strict";

    const DEFAULT_SETTINGS = {enabled: true, pasteClean: false, referralMarketing: false};
    let settings = {...DEFAULT_SETTINGS, enabled: false};
    let revision = 0;
    const specialCache = new Map();
    const specialPending = new Map();
    let clipboardRequest = null;
    const clipboardResolutions = new WeakSet();
    let lastClipboardRequestId = 0;
    const MAX_CACHE = 100;
    const SUCCESS_TTL = 300000;
    const FAILURE_TTL = 15000;

    function broadcastNavigationSettings() {
        window.postMessage({source: "clean-urls-copy", type: "settings",
            enabled: Boolean(settings.enabled), pasteClean: Boolean(settings.pasteClean),
            referralMarketing: Boolean(settings.referralMarketing)}, "*");
    }

    function loadSettings() {
        const version = revision;
        return chrome.storage.local.get(DEFAULT_SETTINGS).then(result => {
            if (version !== revision) return;
            settings = {...DEFAULT_SETTINGS, ...result};
            broadcastNavigationSettings();
        }).catch(() => {});
    }

    function isPureURL(value) {
        if (typeof value !== "string" || !/^https?:\/\//i.test(value)
            || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
        try {
            const url = new URL(value);
            return !url.username && !url.password;
        } catch (error) {
            return false;
        }
    }

    function closestAnchor(node) {
        const element = node?.nodeType === 3 ? node.parentElement : node;
        return element?.closest?.("a[href], area[href]") || null;
    }

    function isEditable(node) {
        const element = node?.nodeType === 3 ? node.parentElement : node;
        return Boolean(element && (element.isContentEditable
            || element.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")));
    }

    function selectedURL(event) {
        if (isEditable(event?.target) || isEditable(document.activeElement)
            || event?.composedPath?.().some(isEditable)) return null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
        const range = selection.getRangeAt(0);
        if (range.startContainer !== range.endContainer || range.startContainer?.nodeType !== 3
            || isEditable(range.startContainer)) return null;
        const parent = range.startContainer.parentElement;
        if (!parent || parent.closest?.("a, b, strong, i, em, u, s, code, pre, [style], [class]")) return null;
        const value = selection.toString();
        return isPureURL(value) ? value : null;
    }

    function cached(value) {
        const entry = specialCache.get(value);
        if (!entry) return null;
        if (entry.expires <= Date.now()) {
            specialCache.delete(value);
            return null;
        }
        return entry.result;
    }

    function remember(value, result) {
        specialCache.delete(value);
        if (specialCache.size >= MAX_CACHE) specialCache.delete(specialCache.keys().next().value);
        specialCache.set(value, {result, expires: Date.now() + (result ? SUCCESS_TTL : FAILURE_TTL)});
    }

    function verifiedResult(value, result) {
        if (!result || result.input !== value || result.safe !== true || result.resolved !== true) return null;
        const canonical = CleanURLsSpecial.validateThreadsResolvedURL(result.resolvedURL);
        if (!canonical || canonical !== result.output) return null;
        return {input: value, output: canonical, safe: true, changed: canonical !== value, resolved: true, removed: []};
    }

    function prefetchSpecialURL(value) {
        if (!settings.enabled || typeof value !== "string" || value.length > 8192
            || !window.CleanURLsSpecial || !CleanURLsSpecial.isThreadsShareURL(value)) return;
        const result = cached(value);
        if (specialCache.has(value)) return Promise.resolve(result);
        if (specialPending.has(value)) return specialPending.get(value).promise;
        if (specialPending.size >= 16) return Promise.resolve(null);
        const version = revision;
        const entry = {};
        const expired = new Promise(resolve => {
            entry.cancel = () => resolve(null);
            entry.timeout = setTimeout(entry.cancel, 6000);
        });
        entry.promise = Promise.race([Promise.resolve().then(() => version === revision && settings.enabled
            ? chrome.runtime.sendMessage({type: "resolveSpecialURL", url: value}) : null), expired])
            .then(result => verifiedResult(value, result)).catch(() => null).then(result => {
                if (version !== revision || !settings.enabled) return null;
                remember(value, result);
                return result;
            }).finally(() => {
                clearTimeout(entry.timeout);
                if (specialPending.get(value) === entry) specialPending.delete(value);
            });
        specialPending.set(value, entry);
        return entry.promise;
    }

    function resolveClipboardRequest(message) {
        const {requestId, input} = message;
        if (!settings.enabled || !Number.isSafeInteger(requestId) || requestId <= lastClipboardRequestId
            || !isPureURL(input) || input.length > 8192 || !window.CleanURLsSpecial
            || !CleanURLsSpecial.isThreadsShareURL(input)) return;
        lastClipboardRequestId = requestId;
        const promise = Promise.resolve(prefetchSpecialURL(input));
        clipboardRequest = {requestId, input, version: revision, promise};
        if (clipboardResolutions.has(promise)) return;
        clipboardResolutions.add(promise);
        promise.then(result => {
            const request = clipboardRequest;
            if (!request || request.promise !== promise || request.version !== revision || !settings.enabled) return;
            clipboardRequest = null;
            window.postMessage({source: "clean-urls-copy", type: "clipboard-resolve-result",
                requestId: request.requestId, input: request.input, result: result || null}, "*");
        }).catch(() => {
            if (clipboardRequest?.promise === promise) clipboardRequest = null;
        });
    }

    function notifyBackground(result, source) {
        try {
            Promise.resolve(chrome.runtime.sendMessage({type: "copyCleaned", before: result.input,
                after: result.output, removed: result.removed, source})).catch(() => {});
        } catch (error) {}
    }

    function localResult(input) {
        return CleanURLs.cleanURL(input, {...CLEAN_URLS_RULES, enabled: true,
            sourceURL: window.location?.href, referralMarketing: Boolean(settings.referralMarketing)});
    }

    function handleCopy(event) {
        if (!settings.enabled || event.defaultPrevented || !event.cancelable
            || !event.clipboardData || typeof event.clipboardData.setData !== "function") return;
        try {
            if (Array.from(event.clipboardData.types || []).some(type => type !== "text/plain")) return;
            const value = selectedURL(event);
            if (!value) return;
            let result;
            if (window.CleanURLsSpecial && CleanURLsSpecial.isThreadsShareURL(value)) {
                result = cached(value);
                if (!result) {
                    prefetchSpecialURL(value);
                    return;
                }
            } else {
                result = localResult(value);
            }
            if (!result?.changed || !result.safe || !isPureURL(result.output)) return;
            event.clipboardData.setData("text/plain", result.output);
            event.preventDefault();
            notifyBackground(result, "selection");
        } catch (error) {}
    }

    window.addEventListener("message", event => {
        if (event.source !== window || !event.data || event.data.source !== "clean-urls-copy-navigation") return;
        if (event.data.type === "clipboard-resolve-request") {
            resolveClipboardRequest(event.data);
            return;
        }
        if (event.data.type === "prefetch-special") {
            prefetchSpecialURL(event.data.value);
            return;
        }
        if (!settings.enabled || event.data.type !== "clipboard-committed") return;
        try {
            const {before, after} = event.data;
            if (!isPureURL(before) || !isPureURL(after)
                || (window.CleanURLsSpecial && CleanURLsSpecial.isThreadsShareURL(before))) return;
            const result = localResult(before);
            if (!result.safe || !result.changed || result.output !== after) return;
            Promise.resolve(chrome.runtime.sendMessage({type: "clipboardCleaned", before, after,
                removed: result.removed, resolved: false})).catch(() => {});
        } catch (error) {}
    });
    document.addEventListener("copy", handleCopy);
    for (const type of ["pointerover", "focusin"]) {
        document.addEventListener(type, event => {
            if (!settings.enabled || isEditable(event.target)) return;
            const anchor = closestAnchor(event.target);
            if (anchor?.href) prefetchSpecialURL(anchor.href);
        }, true);
    }
    document.addEventListener("selectionchange", () => {
        if (!settings.enabled) return;
        try {
            const value = selectedURL();
            if (value) prefetchSpecialURL(value);
        } catch (error) {}
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !["enabled", "pasteClean", "referralMarketing"].some(key => changes[key])) return;
        revision += 1;
        for (const key of ["enabled", "pasteClean", "referralMarketing"]) {
            if (changes[key]) settings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
        }
        clipboardRequest = null;
        for (const entry of specialPending.values()) entry.cancel();
        specialPending.clear();
        specialCache.clear();
        broadcastNavigationSettings();
    });
    loadSettings();
})();
