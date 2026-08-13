(() => {
    "use strict";

    const FUNCTIONAL_PARAMETERS = new Set([
        "q", "query", "search", "keyword", "keywords", "page", "p", "id", "ids",
        "item", "itemid", "product", "productid", "sku", "asin", "v", "video", "list",
        "index", "sort", "order", "filter", "category", "cat", "tag", "tags", "lang",
        "language", "locale", "country", "region", "ref", "redirect", "redirect_uri",
        "url", "uri", "u", "to", "next", "continue", "return", "returnurl",
        "return_url", "destination", "target", "download", "file", "filename", "token",
        "code", "state", "session", "sessionid", "auth", "key", "cursor", "limit",
        "offset", "from", "date", "start", "end", "time", "t", "time_continue", "type", "format", "view",
        "mode", "version", "callback", "domain", "email", "username", "invite", "channel",
        "playlist", "playlist_id", "video_id", "embed", "autoplay", "mute", "controls", "loop"
    ]);

    const GLOBAL_TRACKING_PATTERNS = [
        /^utm(?:_[a-z0-9]+)?$/i,
        /^mtm(?:_[a-z0-9]+)?$/i,
        /^ga_[a-z0-9_]+$/i,
        /^_ga$/i,
        /^_gl$/i,
        /^gclid$/i,
        /^dclid$/i,
        /^fbclid$/i,
        /^fb_(?:source|ref)$/i,
        /^msclkid$/i,
        /^twclid$/i,
        /^yclid$/i,
        /^srsltid$/i,
        /^_openstat$/i,
        /^mkt_tok$/i,
        /^mc_(?:cid|eid|tc)$/i,
        /^__hs(?:fp|sc|tc|enc)$/i,
        /^hsCtaTracking$/i,
        /^ml_subscriber(?:_hash)?$/i,
        /^oly_(?:anon_id|enc_id)$/i,
        /^rb_clickid$/i,
        /^s_cid$/i,
        /^vero_(?:conv|id)$/i,
        /^wickedid$/i,
        /^tracking_source$/i,
        /^itm_(?:campaign|medium|source)$/i,
        /^cmpid$/i,
        /^Echobox$/i,
        /^spm$/i,
        /^referrer$/i,
        /^ref_?id$/i,
        /^ref_?source$/i,
        /^campaign_id$/i,
        /^campaignid$/i,
        /^click(?:id|_id|info)$/i,
        /^trk(?:ing)?(?:id|_id|parms)?$/i,
        /^affiliate(?:_id|id)?$/i,
        /^aff_(?:id|source|track)$/i,
        /^source_(?:id|name)$/i,
        /^tracking(?:_id|id)?$/i
    ];

    const CACHE = new Map();
    let rulesData = null;

    function safeRegExp(pattern, flags = "i") {
        try {
            return new RegExp(pattern, flags);
        } catch (error) {
            return null;
        }
    }

    function getRulesData() {
        if (rulesData) return rulesData;
        try {
            if (typeof CLEAN_URLS_RULES !== "undefined") rulesData = CLEAN_URLS_RULES;
        } catch (error) {
            rulesData = null;
        }
        return rulesData;
    }

    function isURL(value) {
        return typeof value === "string" && /^https?:\/\//i.test(value.trim());
    }

    function normalizeURL(value) {
        if (!isURL(value)) return null;
        try {
            const url = new URL(value.trim());
            if (url.username || url.password) return null;
            return url;
        } catch (error) {
            return null;
        }
    }

    function isFunctionalParameter(name) {
        return FUNCTIONAL_PARAMETERS.has(String(name).toLowerCase());
    }

    function matchesAny(patterns, value) {
        return patterns.some(pattern => pattern && pattern.test(value));
    }

    function providerFor(url, provider) {
        const expression = safeRegExp(provider.urlPattern || ".*", "i");
        return Boolean(expression && expression.test(url));
    }

    function providerException(provider, url) {
        return (provider.exceptions || []).some(pattern => {
            const expression = safeRegExp(pattern, "i");
            return Boolean(expression && expression.test(url));
        });
    }

    function providerParameterMatch(provider, name) {
        return (provider.rules || []).some(pattern => {
            const expression = safeRegExp(`^(?:${pattern})$`, "i");
            return Boolean(expression && expression.test(name));
        });
    }

    function hostMatches(host, candidate) {
        const normalizedHost = String(host || "").toLowerCase();
        const normalizedCandidate = String(candidate || "").toLowerCase();
        return normalizedCandidate === normalizedHost || normalizedCandidate.endsWith(`.${normalizedHost}`);
    }

    function adguardParameterMatch(url, name, value, data) {
        const adguard = data && data.adguard;
        if (!adguard) return false;
        const pair = `${name}=${value ?? ""}`;
        const literalMatch = values => (values || []).some(item => String(item).toLowerCase() === String(name).toLowerCase());
        const patternMatch = values => (values || []).some(pattern => {
            const expression = safeRegExp(pattern, "i");
            return Boolean(expression && (expression.test(name) || expression.test(pair)));
        });
        if (literalMatch(adguard.globalLiterals) || patternMatch(adguard.globalPatterns)) return true;
        for (const site of adguard.siteRules || []) {
            if (!hostMatches(site.host, url.hostname || "")) continue;
            if (literalMatch(site.literals) || patternMatch(site.patterns)) return true;
        }
        return false;
    }

    function shouldRemoveParameter(url, name, value, data) {
        const lowerName = name.toLowerCase();
        if (isFunctionalParameter(lowerName)) return false;

        if (adguardParameterMatch(url, name, value, data)) return true;

        const globalProvider = data && data.providers && data.providers.globalRules;
        if (globalProvider && !providerException(globalProvider, url)) {
            const patterns = (globalProvider.rules || [])
                .map(pattern => safeRegExp(pattern.replace(/^\(\?:%3F\)\?/, ""), "i"))
                .filter(Boolean);
            if (patterns.some(pattern => pattern.test(name)) || matchesAny(GLOBAL_TRACKING_PATTERNS, name)) {
                return true;
            }
        } else if (matchesAny(GLOBAL_TRACKING_PATTERNS, name)) {
            return false;
        }

        for (const [providerName, provider] of Object.entries(data?.providers || {})) {
            if (providerName === "globalRules") continue;
            if (!providerFor(url, provider) || providerException(provider, url)) continue;
            if (providerParameterMatch(provider, name)) return true;
            if (data.referralMarketing && (provider.referralMarketing || []).some(pattern => {
                const expression = safeRegExp(`^(?:${pattern})$`, "i");
                return Boolean(expression && expression.test(name));
            })) return true;
        }

        return false;
    }

    function cleanURL(input, data = getRulesData()) {
        const url = normalizeURL(input);
        if (!url || !data || data.enabled === false) {
            return {input, output: input, changed: false, safe: false, removed: []};
        }

        const source = url.toString();
        const cached = CACHE.get(source);
        if (cached) return {...cached, removed: [...cached.removed]};

        const removed = [];
        for (const name of [...url.searchParams.keys()]) {
            const value = url.searchParams.get(name) || "";
            if (shouldRemoveParameter(url, name, value, data)) {
                url.searchParams.delete(name);
                removed.push(name);
            }
        }

        if (!removed.length) {
            const result = {input, output: input, changed: false, safe: true, removed: []};
            CACHE.set(source, result);
            return result;
        }

        const output = url.toString();
        const result = {
            input,
            output,
            changed: output !== input,
            safe: output.startsWith(`${url.protocol}//${url.host}${url.pathname}`),
            removed
        };
        if (result.safe) CACHE.set(source, result);
        return result;
    }

    function extractSingleURL(text) {
        if (typeof text !== "string") return null;
        const value = text.trim();
        if (!isURL(value) || /[\r\n]/.test(value)) return null;
        return value;
    }

    function extractLinkURL(element) {
        if (!element || !element.href || !isURL(element.href)) return null;
        return element.href;
    }

    globalThis.CleanURLs = {
        FUNCTIONAL_PARAMETERS,
        GLOBAL_TRACKING_PATTERNS,
        adguardParameterMatch,
        cleanURL,
        extractSingleURL,
        extractLinkURL,
        isURL,
        getRulesData,
        clearCache() { CACHE.clear(); }
    };
})();
