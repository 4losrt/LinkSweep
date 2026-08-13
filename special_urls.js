(() => {
    "use strict";

    const THREADS_HOST = /^(?:www\.)?threads\.com$/i;
    const THREADS_SHARE_PATH = /^\/share\/[A-Za-z0-9_-]+\/?$/i;
    const THREADS_POST_PATH = /^(?:\/@[^/]+\/post\/[^/?#]+|\/post\/[^/?#]+)\/?$/i;

    function parseURL(value) {
        try {
            return new URL(value);
        } catch (error) {
            return null;
        }
    }

    function isThreadsHost(url) {
        return Boolean(url && THREADS_HOST.test(url.hostname));
    }

    function isThreadsShareURL(value) {
        const url = parseURL(value);
        return Boolean(url && (url.protocol === "https:" || url.protocol === "http:")
            && isThreadsHost(url) && THREADS_SHARE_PATH.test(url.pathname));
    }

    function isThreadsPostURL(value) {
        const url = parseURL(value);
        return Boolean(url && url.protocol === "https:" && isThreadsHost(url)
            && THREADS_POST_PATH.test(url.pathname));
    }

    function validateThreadsResolvedURL(value) {
        if (!isThreadsPostURL(value)) return null;
        const url = parseURL(value);
        url.hash = "";
        return url.toString();
    }

    function isYouTubeURL(value) {
        const url = parseURL(value);
        return Boolean(url && /^(?:www\.)?(?:youtube\.com|youtu\.be)$/i.test(url.hostname));
    }

    globalThis.CleanURLsSpecial = {
        isThreadsShareURL,
        isThreadsPostURL,
        validateThreadsResolvedURL,
        isYouTubeURL
    };
})();
