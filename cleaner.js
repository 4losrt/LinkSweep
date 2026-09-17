(() => {
    "use strict";

    const FUNCTIONAL_PARAMETERS = new Set([
        "q", "s", "query", "search", "keyword", "keywords", "page", "p", "id", "ids",
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
        /^Echobox$/i
    ];

    const REGEX_CACHE = new Map();
    const AUTH_PARAMETER = /^(?:.*(?:token|signature|session|nonce|csrf|xsrf|credential|password).*|code|state|auth|authorization|key|api[_-]?key|sig|hmac|jwt|samlrequest|samlresponse|relaystate|policy|expires|expiry|key-pair-id|x-amz-.*|x-goog-.*|oauth[_-].*|access[_-]?key|awsaccesskeyid)$/i;

    function safeRegExp(pattern, flags = "i") {
        const key = `${flags}:${pattern}`;
        if (REGEX_CACHE.has(key)) return REGEX_CACHE.get(key);
        let expression = null;
        try {
            expression = new RegExp(pattern, flags);
        } catch (error) {
            expression = null;
        }
        if (REGEX_CACHE.size >= 256) REGEX_CACHE.delete(REGEX_CACHE.keys().next().value);
        REGEX_CACHE.set(key, expression);
        return expression;
    }

    function getRulesData() {
        return typeof CLEAN_URLS_RULES !== "undefined" ? CLEAN_URLS_RULES : null;
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
        if (!provider.urlPattern) return false;
        const expression = safeRegExp(provider.urlPattern, "i");
        return Boolean(expression && expression.test(url));
    }

    function providerException(provider, url) {
        return (provider.exceptions || []).some(pattern => {
            const expression = safeRegExp(pattern, "i");
            return !expression || expression.test(url);
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

    function filterParameterMatch(rule, name, value) {
        if ((rule.literals || []).includes(name)) return true;
        return (rule.patterns || []).some(pattern => {
            const expression = safeRegExp(pattern, "");
            return Boolean(expression && expression.test(`${name}=${value}`));
        });
    }

    function initiatorMatches(scope, sourceURL) {
        if (!scope || scope.unsupported) return true;
        const domains = [scope.include, scope.exclude];
        if (domains.some(list => !Array.isArray(list) || list.some(host => typeof host !== "string"
            || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(host)))) return true;
        const source = normalizeURL(sourceURL);
        if (!source || /[\u0000-\u0020\u007f\\]/.test(sourceURL)) return true;
        const host = source.hostname.replace(/\.$/, "");
        if (scope.exclude.some(domain => hostMatches(domain, host))) return false;
        return !scope.include.length || scope.include.some(domain => hostMatches(domain, host));
    }

    function filterException(url, name, value, data) {
        return (data?.adguard?.exceptions || []).some(rule => {
            const expression = safeRegExp(rule.urlPattern || ".*");
            return (!expression || expression.test(url.href))
                && initiatorMatches(rule.initiator, data.sourceURL)
                && (rule.all || (rule.literals || []).some(item => item.toLowerCase() === name.toLowerCase())
                    || (rule.patterns || []).some(pattern => {
                        const parameter = safeRegExp(pattern, "i");
                        return !parameter || parameter.test(`${name}=${value}`);
                    }));
        });
    }

    function adguardParameterMatch(url, name, value, data) {
        const adguard = data && data.adguard;
        if (!adguard) return false;
        if (filterException(url, name, value, data)) return false;
        if (matchesAny(GLOBAL_TRACKING_PATTERNS, name) && filterParameterMatch({
            literals: adguard.globalLiterals, patterns: adguard.globalPatterns
        }, name, value)) return true;
        for (const site of adguard.siteRules || []) {
            if (!hostMatches(site.host, url.hostname || "")) continue;
            if (filterParameterMatch(site, name, value)) return true;
        }
        return false;
    }

    function shouldRemoveParameter(url, name, value, data) {
        if (AUTH_PARAMETER.test(name) || filterException(url, name, value, data)) return false;
        const functional = isFunctionalParameter(name);
        const providers = Object.entries(data.providers || {});
        const applicable = providers.filter(([key, provider]) => key !== "globalRules" && providerFor(url, provider));
        if (applicable.some(([, provider]) => providerException(provider, url))) return false;
        const globalProvider = data.providers?.globalRules;
        if (globalProvider && providerException(globalProvider, url)) return false;
        const referral = applicable.some(([, provider]) => providerParameterMatch({rules: provider.referralMarketing}, name));
        if (referral) return Boolean(data.referralMarketing && (!functional || name.toLowerCase() === "tag"));
        if (functional) return false;
        if (adguardParameterMatch(url, name, value, data)) return true;
        if (globalProvider && matchesAny(GLOBAL_TRACKING_PATTERNS, name)
            && providerParameterMatch(globalProvider, name)) return true;
        return applicable.some(([, provider]) => providerParameterMatch(provider, name));
    }

    function cleanURL(input, data = getRulesData()) {
        const url = normalizeURL(input);
        if (!url || !data || data.enabled === false) {
            return {input, output: input, changed: false, safe: false, removed: []};
        }

        const unchanged = {input, output: input, changed: false, safe: true, removed: []};
        if (/[\u0000-\u0020\u007f\\]/.test(input) || input !== input.trim()) return {...unchanged, safe: false};
        const hashIndex = input.indexOf("#");
        const end = hashIndex < 0 ? input.length : hashIndex;
        const queryIndex = input.indexOf("?");
        if (queryIndex < 0 || queryIndex > end) return unchanged;
        const decode = value => decodeURIComponent(value.replace(/\+/g, " "));
        let fields;
        try {
            fields = input.slice(queryIndex + 1, end).split("&").map(raw => {
                const separator = raw.indexOf("=");
                return {raw, name: decode(separator < 0 ? raw : raw.slice(0, separator)),
                    value: decode(separator < 0 ? "" : raw.slice(separator + 1))};
            });
            const fragment = decode(input.slice(end));
            if (fields.some(field => AUTH_PARAMETER.test(field.name))
                || /(?:^|[#?&])(?:[^=&#]*(?:token|signature|auth)|code|state)=/i.test(fragment)) {
                return {...unchanged, safe: false};
            }
        } catch (error) {
            return {...unchanged, safe: false};
        }
        const removed = [];
        const kept = fields.filter(field => {
            if (!shouldRemoveParameter(url, field.name, field.value, data)) return true;
            removed.push(field.name);
            return false;
        });
        if (!removed.length) return unchanged;
        const output = input.slice(0, queryIndex)
            + (kept.length ? `?${kept.map(field => field.raw).join("&")}` : "") + input.slice(end);
        return {input, output, changed: true, safe: true, removed};
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
        clearCache() { REGEX_CACHE.clear(); }
    };
})();
