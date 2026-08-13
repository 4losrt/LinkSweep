(() => {
    "use strict";

    const state = {
        enabled: true,
        pasteClean: true,
        referralMarketing: false,
        resolvedCache: new Map(),
        clipboardRequestCounter: 0,
        clipboardPending: new Map(),
        lastThreadsPostContext: null
    };

    function isHttpURL(value) {
        return typeof value === "string" && /^https?:\/\//i.test(value);
    }

    function cleanNavigationURL(value) {
        if (!state.enabled || !isHttpURL(value) || !window.CleanURLs) {
            return {input: value, output: value, changed: false, safe: false, removed: []};
        }
        const cached = state.resolvedCache.get(value);
        if (cached && cached.safe) return cached;
        try {
            return window.CleanURLs.cleanURL(value, {
                ...window.CLEAN_URLS_RULES,
                enabled: true,
                referralMarketing: state.referralMarketing
            });
        } catch (error) {
            return {input: value, output: value, changed: false, safe: false, removed: []};
        }
    }

    function report(result, source) {
        if (!result.changed || !result.safe) return;
        window.postMessage({
            source: "clean-urls-copy-navigation",
            type: "cleaned",
            before: result.input,
            after: result.output,
            removed: result.removed,
            action: source
        }, "*");
    }

    function elementFromEvent(event) {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const item of path) {
            if (item && item.nodeType === 1 && item.matches?.("a[href], area[href]")) return item;
        }
        const target = event.target;
        return target && target.closest ? target.closest("a[href], area[href]") : null;
    }

    function shouldSkipAnchor(anchor, event) {
        return !anchor
            || event.defaultPrevented
            || event.button === 2
            || anchor.hasAttribute("download")
            || anchor.getAttribute("href")?.startsWith("#");
    }

    function temporarilyCleanAnchor(anchor, source) {
        const original = anchor.getAttribute("href");
        const result = cleanNavigationURL(anchor.href);
        if (!result.changed || !result.safe || !isHttpURL(result.output)) return;

        anchor.setAttribute("href", result.output);
        report(result, source);
        setTimeout(() => {
            if (anchor.isConnected && anchor.getAttribute("href") === result.output) {
                anchor.setAttribute("href", original);
            }
        }, 0);
    }

    function handleAnchorEvent(event) {
        if (event.type === "click" && event.button !== 0) return;
        if (event.type === "auxclick" && event.button !== 1) return;
        const anchor = elementFromEvent(event);
        if (shouldSkipAnchor(anchor, event)) return;
        temporarilyCleanAnchor(anchor, event.type);
    }

    function cleanCurrentLocation() {
        if (!state.enabled || !isHttpURL(location.href)) return;
        const result = cleanNavigationURL(location.href);
        if (!result.changed || !result.safe || !isHttpURL(result.output)) return;
        try {
            history.replaceState(history.state, document.title, result.output);
            report(result, "initial-location");
        } catch (error) {
            // Some documents disallow history replacement; leave the URL untouched.
        }
    }

    function threadsPostFromValue(value) {
        try {
            if (window.CleanURLsSpecial && CleanURLsSpecial.isThreadsPostURL(value)) return value;
        } catch (error) {
            // Keep the fallback fail-closed when special URL helpers are unavailable.
        }
        return null;
    }

    function rememberThreadsPostContext(value) {
        const post = threadsPostFromValue(value);
        if (post) state.lastThreadsPostContext = {url: post, at: Date.now()};
    }

    function findThreadsPostInEvent(event) {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const item of path) {
            if (!item || item.nodeType !== 1) continue;
            if (item.matches?.("a[href]")) {
                const direct = threadsPostFromValue(item.href);
                if (direct) return direct;
            }
            for (const anchor of item.querySelectorAll?.("a[href]") || []) {
                const nested = threadsPostFromValue(anchor.href);
                if (nested) return nested;
            }
        }
        return null;
    }

    function isTrustedResolvedPair(input, output, resolved = false) {
        if (!isHttpURL(input) || !isHttpURL(output)) return false;
        if (window.CleanURLsSpecial && CleanURLsSpecial.isThreadsShareURL(input)) {
            return Boolean(resolved && CleanURLsSpecial.isThreadsPostURL(output));
        }
        try {
            const local = CleanURLs.cleanURL(input, {
                ...window.CLEAN_URLS_RULES,
                enabled: true,
                referralMarketing: Boolean(state.referralMarketing)
            });
            return Boolean(local.safe && local.changed && local.output === output);
        } catch (error) {
            return false;
        }
    }

    function contextualThreadsResult(input) {
        if (!window.CleanURLsSpecial || !CleanURLsSpecial.isThreadsShareURL(input)) return null;
        const context = state.lastThreadsPostContext;
        const candidate = context && Date.now() - context.at < 8000 ? context.url : null;
        if (!candidate) return null;
        const result = cleanNavigationURL(candidate);
        if (!result.safe || !isHttpURL(result.output)) return null;
        return {
            input,
            output: result.output,
            safe: true,
            changed: result.output !== input,
            resolved: true,
            removed: Array.isArray(result.removed) ? result.removed : [],
            resolvedURL: candidate
        };
    }

    function requestClipboardClean(value) {
        const requestId = `${Date.now()}-${++state.clipboardRequestCounter}`;
        const message = {
            source: "clean-urls-copy-navigation",
            type: "clipboard-request",
            requestId,
            value
        };
        return new Promise(resolve => {
            const resend = setInterval(() => window.postMessage(message, "*"), 250);
            const timeout = setTimeout(() => {
                clearInterval(resend);
                state.clipboardPending.delete(requestId);
                resolve({input: value, output: value, safe: false, changed: false, removed: []});
            }, 6500);
            state.clipboardPending.set(requestId, {resolve, timeout, resend});
            window.postMessage(message, "*");
        });
    }

    async function getClipboardCleanResult(input) {
        if (!state.enabled || !state.pasteClean || !isHttpURL(input)) {
            return {input, output: input, safe: false, changed: false, removed: []};
        }
        const contextual = contextualThreadsResult(input);
        if (contextual) return contextual;
        const result = await requestClipboardClean(input);
        return result && result.safe && isHttpURL(result.output)
            ? result
            : {input, output: input, safe: false, changed: false, removed: []};
    }

    async function cleanClipboardText(input) {
        const result = await getClipboardCleanResult(input);
        return result.output;
    }

    function reportClipboardCommit(result) {
        if (!result || !result.changed || !result.safe) return;
        window.postMessage({
            source: "clean-urls-copy-navigation",
            type: "clipboard-committed",
            before: result.input,
            after: result.output,
            removed: result.removed,
            resolved: Boolean(result.resolved)
        }, "*");
    }

    async function cleanClipboardItem(item) {
        if (!item || !Array.isArray(item.types) || !item.types.includes("text/plain")) return item;
        try {
            const blob = await item.getType("text/plain");
            const input = await blob.text();
            if (!isHttpURL(input.trim())) return item;
            const output = await cleanClipboardText(input.trim());
            if (output === input.trim()) return item;
            const values = {};
            for (const type of item.types) {
                values[type] = type === "text/plain"
                    ? new Blob([output], {type: "text/plain"})
                    : item.getType(type);
            }
            return new ClipboardItem(values);
        } catch (error) {
            return item;
        }
    }

    function wrapClipboardWrite() {
        const clipboard = navigator.clipboard;
        if (!clipboard) return;
        if (clipboard.__linkSweepWriteWrapped) return;
        const nativeWriteText = typeof clipboard.writeText === "function"
            ? clipboard.writeText.bind(clipboard)
            : null;
        const nativeWrite = typeof clipboard.write === "function"
            ? clipboard.write.bind(clipboard)
            : null;
        const wrappedWriteText = nativeWriteText ? async function(value) {
            const input = typeof value === "string" ? value : String(value ?? "");
            const result = await getClipboardCleanResult(input);
            const written = await nativeWriteText(result.output);
            reportClipboardCommit(result);
            return written;
        } : null;
        const wrappedWrite = nativeWrite ? async function(items) {
            if (!state.enabled || !state.pasteClean || !Array.isArray(items)) {
                return nativeWrite(items);
            }
            const cleanedItems = await Promise.all(items.map(cleanClipboardItem));
            return nativeWrite(cleanedItems);
        } : null;
        try {
            if (wrappedWriteText) {
                Object.defineProperty(clipboard, "writeText", {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: wrappedWriteText
                });
            }
            if (wrappedWrite) {
                Object.defineProperty(clipboard, "write", {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: wrappedWrite
                });
            }
            Object.defineProperty(clipboard, "__linkSweepWriteWrapped", {
                configurable: false,
                value: true
            });
        } catch (error) {
            // Some pages expose a non-configurable clipboard object; leave it untouched.
        }
    }

    function wrapWindowOpen() {
        if (typeof window.open !== "function" || window.__cleanURLsCopyOpenWrapped) return;
        const nativeOpen = window.open;
        const wrappedOpen = function(url, target, features) {
            const result = cleanNavigationURL(url);
            const output = result.changed && result.safe ? result.output : url;
            if (result.changed && result.safe) report(result, "window.open");
            return nativeOpen.call(this, output, target, features);
        };
        try {
            window.open = wrappedOpen;
            window.__cleanURLsCopyOpenWrapped = true;
        } catch (error) {
            // Some pages expose a non-writable window.open; leave it untouched.
        }
    }

    window.addEventListener("message", event => {
        if (event.source !== window || !event.data || event.data.source !== "clean-urls-copy") return;
        if (event.data.type === "clipboard-response") {
            const pending = state.clipboardPending.get(event.data.requestId);
            if (!pending || event.data.input !== pending.input) return;
            const output = typeof event.data.output === "string" ? event.data.output : pending.input;
            const resolved = Boolean(event.data.resolved);
            const safe = Boolean(event.data.safe)
                && isTrustedResolvedPair(pending.input, output, resolved);
            clearTimeout(pending.timeout);
            clearInterval(pending.resend);
            state.clipboardPending.delete(event.data.requestId);
            pending.resolve({
                input: pending.input,
                output: safe ? output : pending.input,
                safe,
                changed: safe && output !== pending.input,
                removed: safe && Array.isArray(event.data.removed) ? event.data.removed : [],
                resolved: safe && resolved
            });
            return;
        }
        if (event.data.type === "resolved-cache") {
            const input = typeof event.data.input === "string" ? event.data.input : "";
            const output = typeof event.data.output === "string" ? event.data.output : "";
            if (input && output && event.data.safe
                && isTrustedResolvedPair(input, output, Boolean(event.data.resolved))) {
                state.resolvedCache.set(input, {
                    input,
                    output,
                    changed: output !== input,
                    safe: true,
                    removed: Array.isArray(event.data.removed) ? event.data.removed : []
                });
            }
            return;
        }
        if (event.data.type !== "settings") return;
        state.enabled = Boolean(event.data.enabled);
        state.pasteClean = Boolean(event.data.pasteClean);
        state.referralMarketing = Boolean(event.data.referralMarketing);
        wrapWindowOpen();
        wrapClipboardWrite();
        cleanCurrentLocation();
    });

    document.addEventListener("click", event => {
        const target = event.target && event.target.closest
            ? event.target.closest("[role=\"button\"], button, [aria-label]")
            : null;
        const label = target
            ? `${target.getAttribute("aria-label") || ""} ${target.textContent || ""}`.trim()
            : "";
        if (/\bshare\b|copy\s+link/i.test(label)) {
            const context = findThreadsPostInEvent(event);
            if (context) rememberThreadsPostContext(context);
        }
        handleAnchorEvent(event);
    }, true);
    document.addEventListener("auxclick", handleAnchorEvent, true);
    wrapWindowOpen();
    wrapClipboardWrite();
})();
