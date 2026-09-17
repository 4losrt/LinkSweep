(() => {
    "use strict";

    const state = {enabled: false, referralMarketing: false};

    function isHttpURL(value) {
        if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
        try {
            const url = new URL(value);
            return !url.username && !url.password;
        } catch (error) {
            return false;
        }
    }

    function isThreadsShare(value) {
        try {
            const url = new URL(value);
            return /^(?:www\.)?threads\.com$/i.test(url.hostname) && /^\/share\//i.test(url.pathname);
        } catch (error) {
            return false;
        }
    }

    function cleanNavigationURL(value) {
        const unchanged = {input: value, output: value, changed: false, safe: false, removed: []};
        if (!state.enabled || !isHttpURL(value) || isThreadsShare(value) || !window.CleanURLs) return unchanged;
        try {
            const result = window.CleanURLs.cleanURL(value, {
                ...window.CLEAN_URLS_RULES,
                enabled: true,
                sourceURL: window.location?.href,
                referralMarketing: state.referralMarketing
            });
            return result && result.safe && isHttpURL(result.output) ? result : unchanged;
        } catch (error) {
            return unchanged;
        }
    }

    function post(message) {
        try {
            window.postMessage({source: "clean-urls-copy-navigation", ...message}, "*");
        } catch (error) {}
    }

    let clipboardSequence = 0;
    let pendingClipboard = null;

    function cancelClipboard() {
        if (!pendingClipboard) return;
        const error = new Error("Clipboard write superseded");
        error.name = "AbortError";
        pendingClipboard.finish(null, error);
    }

    function pendingBlob() {
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        promise.catch(() => {});
        const operation = {promise, requestId: clipboardSequence, input: null, original: null, timer: null,
            finish(blob, error) {
                if (pendingClipboard !== operation) return;
                clearTimeout(operation.timer);
                pendingClipboard = null;
                if (arguments.length > 1) reject(error);
                else resolve(blob);
            }};
        pendingClipboard = operation;
        operation.timer = setTimeout(() => {
            if (pendingClipboard !== operation) return;
            if (state.enabled && operation.original) operation.finish(operation.original);
            else cancelClipboard();
        }, 6000);
        return operation;
    }

    function resolveClipboardBlob(operation, input, original) {
        if (pendingClipboard !== operation) return;
        if (!state.enabled) {
            cancelClipboard();
            return;
        }
        if (typeof input === "string" && input.length <= 8192 && isHttpURL(input) && isThreadsShare(input)) {
            operation.input = input;
            operation.original = original;
            post({type: "clipboard-resolve-request", requestId: operation.requestId, input});
            return;
        }
        const result = cleanNavigationURL(input);
        operation.finish(result.changed && result.safe ? new Blob([result.output], {type: "text/plain"}) : original);
    }

    function receiveClipboardResult(message) {
        const operation = pendingClipboard;
        if (!state.enabled || !operation || operation.input === null
            || message.requestId !== operation.requestId || message.input !== operation.input) return;
        const result = message.result;
        if (result === null) {
            operation.finish(operation.original);
            return;
        }
        if (!result || result.input !== operation.input || result.safe !== true || result.resolved !== true
            || result.changed !== true || !isHttpURL(result.output)) return;
        const url = new URL(result.output);
        if (url.origin !== "https://threads.com" || url.search || url.hash
            || !/^(?:\/@[A-Za-z0-9_.]+)?\/post\/[A-Za-z0-9_-]+$/.test(url.pathname)
            || result.output !== `https://threads.com${url.pathname}`) return;
        operation.finish(new Blob([result.output], {type: "text/plain"}));
    }

    function writePending(nativeWrite, replacement, args, operation) {
        try {
            const written = nativeWrite([replacement], ...args);
            Promise.resolve(written).catch(error => operation.finish(null, error));
            return written;
        } catch (error) {
            operation.finish(null, error);
            throw error;
        }
    }

    function report(result, source) {
        if (!result.changed || !result.safe) return;
        post({type: "cleaned", before: result.input, after: result.output,
            removed: result.removed, action: source});
    }

    function elementFromEvent(event) {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const item of path) {
            if (item && item.nodeType === 1 && item.matches?.("a[href], area[href]")) return item;
        }
        return event.target?.closest?.("a[href], area[href]") || null;
    }

    function handleAnchorEvent(event) {
        if (!state.enabled || event.defaultPrevented
            || (event.type === "click" && event.button !== 0)
            || (event.type === "auxclick" && event.button !== 1)) return;
        const anchor = elementFromEvent(event);
        if (!anchor || anchor.hasAttribute("download") || anchor.getAttribute("href")?.startsWith("#")) return;
        const original = anchor.getAttribute("href");
        const result = cleanNavigationURL(anchor.href);
        if (!result.changed || !result.safe) return;
        anchor.setAttribute("href", result.output);
        report(result, event.type);
        setTimeout(() => {
            if (anchor.isConnected && anchor.getAttribute("href") === result.output) anchor.setAttribute("href", original);
        }, 0);
    }

    function cleanCurrentLocation() {
        const result = cleanNavigationURL(location.href);
        if (!result.changed || !result.safe) return;
        try {
            history.replaceState(history.state, document.title, result.output);
            report(result, "initial-location");
        } catch (error) {}
    }

    function observeCommit(written, result) {
        if (!result.changed || !result.safe) return;
        try {
            Promise.resolve(written).then(() => {
                post({type: "clipboard-committed", before: result.input,
                    after: result.output, removed: result.removed, resolved: false});
            }).catch(() => {});
        } catch (error) {}
    }

    function wrapClipboardWrite() {
        const clipboard = navigator.clipboard;
        if (!clipboard || clipboard.__linkSweepWriteWrapped) return;
        const nativeWriteText = typeof clipboard.writeText === "function" ? clipboard.writeText.bind(clipboard) : null;
        const nativeWrite = typeof clipboard.write === "function" ? clipboard.write.bind(clipboard) : null;
        const wrappedWriteText = nativeWriteText ? function(...args) {
            cancelClipboard();
            clipboardSequence += 1;
            if (!state.enabled || typeof args[0] !== "string") return nativeWriteText(...args);
            const input = args[0];
            if (isHttpURL(input) && isThreadsShare(input)) {
                if (!nativeWrite || typeof ClipboardItem !== "function" || typeof Blob !== "function"
                    || input.length > 8192 || !Number.isSafeInteger(clipboardSequence)) return nativeWriteText(...args);
                const operation = pendingBlob();
                let replacement;
                let original;
                try {
                    original = new Blob([input], {type: "text/plain"});
                    replacement = new ClipboardItem({"text/plain": operation.promise});
                } catch (error) {
                    operation.finish(null, error);
                    return nativeWriteText(...args);
                }
                const written = writePending(nativeWrite, replacement, [], operation);
                resolveClipboardBlob(operation, input, original);
                return written;
            }
            const result = cleanNavigationURL(input);
            const written = nativeWriteText(result.output, ...args.slice(1));
            observeCommit(written, result);
            return written;
        } : null;
        const wrappedWrite = nativeWrite ? function(items, ...args) {
            cancelClipboard();
            clipboardSequence += 1;
            if (!state.enabled || !Array.isArray(items) || items.length !== 1
                || typeof ClipboardItem !== "function" || typeof Blob !== "function"
                || !Number.isSafeInteger(clipboardSequence)) return nativeWrite(items, ...args);
            const item = items[0];
            let pure = false;
            try {
                pure = Boolean(item && item.types.length === 1 && item.types[0] === "text/plain");
            } catch (error) {}
            if (!pure) return nativeWrite(items, ...args);
            const operation = pendingBlob();
            let replacement;
            try {
                replacement = new ClipboardItem({"text/plain": operation.promise}, {presentationStyle: item.presentationStyle});
            } catch (error) {
                operation.finish(null, error);
                return nativeWrite(items, ...args);
            }
            const written = writePending(nativeWrite, replacement, args, operation);
            Promise.resolve().then(() => {
                if (pendingClipboard === operation) return item.getType("text/plain");
            }).then(async original => {
                if (pendingClipboard !== operation) return;
                operation.original = original;
                let input;
                try {
                    input = await original.text();
                } catch (error) {
                    operation.finish(original);
                    return;
                }
                resolveClipboardBlob(operation, input, original);
            }).catch(error => operation.finish(null, error));
            return written;
        } : null;
        try {
            if (wrappedWriteText) Object.defineProperty(clipboard, "writeText", {
                configurable: true, enumerable: true, writable: true, value: wrappedWriteText
            });
            if (wrappedWrite) Object.defineProperty(clipboard, "write", {
                configurable: true, enumerable: true, writable: true, value: wrappedWrite
            });
            Object.defineProperty(clipboard, "__linkSweepWriteWrapped", {value: true});
        } catch (error) {}
    }

    function wrapWindowOpen() {
        if (typeof window.open !== "function" || window.__cleanURLsCopyOpenWrapped) return;
        const nativeOpen = window.open;
        try {
            window.open = function(url, ...args) {
                const result = cleanNavigationURL(url);
                if (result.changed && result.safe) report(result, "window.open");
                return nativeOpen.call(this, result.changed && result.safe ? result.output : url, ...args);
            };
            window.__cleanURLsCopyOpenWrapped = true;
        } catch (error) {}
    }

    window.addEventListener("message", event => {
        if (event.source !== window || !event.data || event.data.source !== "clean-urls-copy") return;
        if (event.data.type === "clipboard-resolve-result") {
            receiveClipboardResult(event.data);
            return;
        }
        if (event.data.type !== "settings") return;
        state.enabled = event.data.enabled === true;
        state.referralMarketing = event.data.referralMarketing === true;
        if (!state.enabled) cancelClipboard();
        cleanCurrentLocation();
    });

    document.addEventListener("click", handleAnchorEvent, true);
    document.addEventListener("auxclick", handleAnchorEvent, true);
    wrapWindowOpen();
    wrapClipboardWrite();
})();
