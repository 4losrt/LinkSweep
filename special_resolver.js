(() => {
    "use strict";

    const CACHE = new Map();
    const MAX_CACHE = 100;

    function parseURL(value) {
        try {
            return new URL(value);
        } catch (error) {
            return null;
        }
    }

    function remember(input, result) {
        if (CACHE.size >= MAX_CACHE) CACHE.delete(CACHE.keys().next().value);
        CACHE.set(input, result);
        return result;
    }

    function cached(input) {
        return CACHE.get(input) || null;
    }

    function decodeHTML(value) {
        return value
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#x27;|&#39;/gi, "'")
            .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, code) => {
                const radix = String(code).toLowerCase().startsWith("x") ? 16 : 10;
                const digits = String(code).replace(/^x/i, "");
                const number = Number.parseInt(digits, radix);
                return Number.isFinite(number) ? String.fromCodePoint(number) : match;
            })
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">");
    }

    function extractMetaURL(html) {
        const candidates = [];
        const metaPattern = /<meta\b[^>]*(?:property|name)=["'](?:og:url|twitter:url)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
        const metaReversePattern = /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:url|twitter:url)["'][^>]*>/gi;
        const canonicalPattern = /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
        for (const pattern of [metaPattern, metaReversePattern, canonicalPattern]) {
            let match;
            while ((match = pattern.exec(html)) !== null) candidates.push(decodeHTML(match[1]));
        }
        return candidates;
    }

    async function resolveThreadsShare(input, settings = {}) {
        const cachedResult = cached(input);
        if (cachedResult) return cachedResult;
        if (!globalThis.CleanURLsSpecial || !CleanURLsSpecial.isThreadsShareURL(input)) {
            return {input, resolved: false, safe: false, output: input, removed: []};
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);
        let response = null;
        try {
            response = await fetch(input, {
                method: "GET",
                redirect: "follow",
                credentials: "omit",
                cache: "no-store",
                signal: controller.signal
            });
        } catch (error) {
            // Extension fetch can still be blocked by CORS or a site policy.
            // A no-cors request cannot expose HTML, but its final response URL
            // can still reveal a safe HTTP redirect when the site permits it.
            try {
                response = await fetch(input, {
                    method: "GET",
                    mode: "no-cors",
                    redirect: "follow",
                    credentials: "omit",
                    cache: "no-store",
                    signal: controller.signal
                });
            } catch (fallbackError) {
                response = null;
            }
        }

        if (response) {
            const candidates = [response.url];
            if (response.type !== "opaque" && response.ok) {
                try {
                    candidates.push(...extractMetaURL(await response.text()));
                } catch (error) {
                    // A response that cannot be read is treated like a redirect-only response.
                }
            }
            for (const candidate of candidates) {
                const resolved = CleanURLsSpecial.validateThreadsResolvedURL(candidate);
                if (!resolved) continue;
                const cleaned = globalThis.CleanURLs.cleanURL(resolved, {
                    ...globalThis.CLEAN_URLS_RULES,
                    enabled: true,
                    referralMarketing: Boolean(settings.referralMarketing)
                });
                clearTimeout(timeout);
                return remember(input, {
                    input,
                    resolved: true,
                    safe: Boolean(cleaned.safe),
                    output: cleaned.safe ? cleaned.output : resolved,
                    removed: cleaned.safe ? cleaned.removed : [],
                    resolvedURL: resolved
                });
            }
        }
        // Network errors, login walls and blocked pages intentionally fail closed.
        clearTimeout(timeout);

        // Do not cache failures: a later poll may succeed after a transient
        // network, CORS, login-wall, or Threads response change.
        return {input, resolved: false, safe: false, output: input, removed: []};
    }

    function storeResolved(result) {
        if (result && result.input) remember(result.input, result);
    }

    globalThis.CleanURLsSpecialResolver = {
        cached,
        resolveThreadsShare,
        storeResolved
    };
})();
