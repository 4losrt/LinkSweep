(() => {
    "use strict";

    const CACHE = new Map();
    const PENDING = new Map();
    const MAX_CACHE = 100;
    const MAX_PENDING = 16;
    const SUCCESS_TTL = 300000;
    const FAILURE_TTL = 15000;
    const MAX_BYTES = 524288;
    const REQUEST_TIMEOUT = 5000;

    function unchanged(input) {
        return {input, resolved: false, safe: false, changed: false, output: input, removed: []};
    }

    function clone(result) {
        return {...result, removed: [...result.removed]};
    }

    function remember(input, result) {
        CACHE.delete(input);
        if (CACHE.size >= MAX_CACHE) CACHE.delete(CACHE.keys().next().value);
        CACHE.set(input, {result: clone(result), expires: Date.now() + (result.resolved ? SUCCESS_TTL : FAILURE_TTL)});
        return result;
    }

    function cached(input) {
        const entry = CACHE.get(input);
        if (!entry) return null;
        if (entry.expires <= Date.now()) {
            CACHE.delete(input);
            return null;
        }
        return clone(entry.result);
    }

    function decodeHTML(value) {
        return value.replace(/&(?:amp|quot|apos|lt|gt|#x[0-9a-f]+|#[0-9]+);/gi, entity => {
            const names = {"&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">"};
            const lower = entity.toLowerCase();
            if (names[lower]) return names[lower];
            const hex = lower.startsWith("&#x");
            const number = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
            return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
                ? String.fromCodePoint(number) : entity;
        });
    }

    function extractCanonical(html) {
        const stripped = html.replace(/<!--[\s\S]*?-->/g, "")
            .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
        const head = stripped.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head\s*>/i);
        if (!head) return null;
        const candidates = new Set();
        const tags = head[1].match(/<(?:meta|link)\b[^>]*>/gi) || [];
        for (const tag of tags) {
            const attributes = new Map();
            const pattern = /\s+([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
            let match;
            let duplicate = false;
            while ((match = pattern.exec(tag))) {
                const name = match[1].toLowerCase();
                if (attributes.has(name)) duplicate = true;
                attributes.set(name, decodeHTML(match[2] ?? match[3]));
            }
            const isLink = /^<link\b/i.test(tag);
            const canonical = isLink && (attributes.get("rel") || "").toLowerCase().split(/\s+/).includes("canonical");
            const meta = !isLink && [attributes.get("property"), attributes.get("name")]
                .some(value => /^(?:og:url|twitter:url)$/i.test(value || ""));
            if (!canonical && !meta) continue;
            if (duplicate) return null;
            const value = attributes.get(canonical ? "href" : "content");
            const normalized = CleanURLsSpecial.validateThreadsResolvedURL(value);
            if (!normalized) return null;
            candidates.add(normalized);
        }
        return candidates.size === 1 ? [...candidates][0] : null;
    }

    async function readBounded(response) {
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error("Response too large");
        if (!response.body || typeof response.body.getReader !== "function") throw new Error("Unreadable response");
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", {fatal: true});
        let size = 0;
        let text = "";
        try {
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) throw new Error("Response too large");
                text += decoder.decode(value, {stream: true});
            }
            return text + decoder.decode();
        } finally {
            Promise.resolve(reader.cancel()).catch(() => {});
            reader.releaseLock();
        }
    }

    async function fetchResolved(input) {
        const controller = new AbortController();
        let timeout;
        const expired = new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
                controller.abort();
                reject(new Error("Resolution timed out"));
            }, REQUEST_TIMEOUT);
        });
        const request = async () => {
            const response = await fetch(input, {
                method: "GET",
                redirect: "follow",
                credentials: "omit",
                cache: "no-store",
                referrerPolicy: "no-referrer",
                signal: controller.signal
            });
            if (!response.ok || response.status < 200 || response.status >= 300
                || response.type === "opaque" || response.type === "opaqueredirect"
                || !/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get("content-type") || "")) {
                throw new Error("Unverified response");
            }
            const redirectedPost = response.redirected
                ? CleanURLsSpecial.validateThreadsResolvedURL(response.url) : null;
            if (redirectedPost) {
                if (response.body) await response.body.cancel();
                return {input, resolved: true, safe: true, changed: redirectedPost !== input,
                    output: redirectedPost, removed: [], resolvedURL: redirectedPost};
            }
            if (response.redirected || !CleanURLsSpecial.isThreadsShareURL(response.url)
                || new URL(response.url).href !== new URL(input).href) {
                throw new Error("Unverified response");
            }
            const resolved = extractCanonical(await readBounded(response));
            if (!resolved) return unchanged(input);
            return {input, resolved: true, safe: true, changed: resolved !== input,
                output: resolved, removed: [], resolvedURL: resolved};
        };
        try {
            return await Promise.race([request(), expired]);
        } catch (error) {
            return unchanged(input);
        } finally {
            clearTimeout(timeout);
            controller.abort();
        }
    }

    async function resolveThreadsShare(input, settings = {}) {
        if ((!settings.enabled && settings.force !== true) || typeof input !== "string" || input.length > 8192
            || !globalThis.CleanURLsSpecial || !CleanURLsSpecial.isThreadsShareURL(input)) return unchanged(input);
        const prior = cached(input);
        if (prior) return prior;
        if (PENDING.has(input)) return clone(await PENDING.get(input));
        if (PENDING.size >= MAX_PENDING) return unchanged(input);
        const pending = fetchResolved(input).then(result => remember(input, result));
        PENDING.set(input, pending);
        try {
            return clone(await pending);
        } finally {
            PENDING.delete(input);
        }
    }

    globalThis.CleanURLsSpecialResolver = {cached, resolveThreadsShare};
})();
