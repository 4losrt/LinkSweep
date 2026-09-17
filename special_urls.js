(() => {
    "use strict";

    const THREADS_HOST = /^(?:www\.)?threads\.com$/i;
    const THREADS_SHARE_PATH = /^\/share\/[A-Za-z0-9_-]+\/?$/;
    const THREADS_POST_PATH = /^(?:\/@[A-Za-z0-9_.]+)?\/post\/[A-Za-z0-9_-]+\/?$/;

    function parseURL(value) {
        if (typeof value !== "string" || !/^https?:\/\/[^/]/i.test(value)
            || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
        try {
            return new URL(value);
        } catch (error) {
            return null;
        }
    }

    function isThreadsHost(url) {
        return Boolean(url && url.protocol === "https:" && !url.username && !url.password
            && !url.port && THREADS_HOST.test(url.hostname));
    }

    function isThreadsShareURL(value) {
        const url = parseURL(value);
        return Boolean(isThreadsHost(url) && THREADS_SHARE_PATH.test(url.pathname));
    }

    function isThreadsPostURL(value) {
        const url = parseURL(value);
        return Boolean(isThreadsHost(url) && THREADS_POST_PATH.test(url.pathname));
    }

    function validateThreadsResolvedURL(value) {
        if (!isThreadsPostURL(value)) return null;
        const url = parseURL(value);
        return `https://threads.com${url.pathname.replace(/\/$/, "")}`;
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
