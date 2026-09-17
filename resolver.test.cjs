const assert = require("node:assert/strict");
const {test} = require("node:test");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {runInNewContext} = require("node:vm");

const share = "https://www.threads.com/share/Ab_12/";
const post = "https://threads.com/@user/post/Post_1";
const html = `<html><head><link href="${post}/?utm_source=x" rel="canonical"><meta content="${post}#fragment" property="og:url"></head><body></body></html>`;

function response(text = html, overrides = {}) {
    const body = new Response(text, {headers: {"content-type": "text/html"}});
    return {ok: true, status: 200, type: "basic", redirected: false, url: share,
        headers: body.headers, body: body.body, ...overrides};
}

function resolver(fetcher, options = {}) {
    let now = 0;
    const calls = [];
    const context = {URL, TextDecoder, AbortController, setTimeout, clearTimeout,
        Date: {now: () => now}, fetch: (...args) => { calls.push(args); return fetcher(...args); }, ...options};
    for (const file of ["special_urls.js", "special_resolver.js"]) {
        runInNewContext(readFileSync(join(__dirname, file), "utf8"), context);
    }
    return {api: context.CleanURLsSpecialResolver, calls, advance: amount => { now += amount; }};
}

function helpers() {
    const context = {URL};
    runInNewContext(readFileSync(join(__dirname, "special_urls.js"), "utf8"), context);
    return context.CleanURLsSpecial;
}

test("Threads only accepts exact HTTPS hosts without credentials or odd ports", () => {
    const special = helpers();
    assert.equal(special.isThreadsShareURL("https://www.threads.com/share/Ab_12/"), true);
    for (const input of ["http://threads.com/share/Ab", "https://user@threads.com/share/Ab", "https://threads.com:444/share/Ab", "https://other.test/share/Ab", "https://threads.com/share/Ab\n"]) {
        assert.equal(special.isThreadsShareURL(input), false, input);
    }
    assert.equal(special.validateThreadsResolvedURL("https://www.threads.com/@user/post/Ab_12/?utm_source=x#fragment"), "https://threads.com/@user/post/Ab_12");
    assert.equal(special.validateThreadsResolvedURL("https://threads.com/share/Ab_12"), null);
});

test("verified canonical metadata resolves and normalizes consistently", async () => {
    const h = resolver(async () => response());
    const result = await h.api.resolveThreadsShare(share, {enabled: true});
    assert.equal(result.output, post);
    assert.equal(result.resolvedURL, post);
    assert.equal(result.safe, true);
    assert.equal(result.changed, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1].redirect, "follow");
    assert.equal(h.calls[0][1].credentials, "omit");
    assert.equal(h.calls[0][1].referrerPolicy, "no-referrer");
    assert.equal(h.calls[0][1].mode, undefined);
    result.removed.push("unrelated");
    assert.equal(h.api.cached(share).removed.length, 0);
    assert.equal((await h.api.resolveThreadsShare(share, {enabled: true})).output, post);
    assert.equal(h.calls.length, 1);
    h.advance(300001);
    assert.equal(h.api.cached(share), null);
    await h.api.resolveThreadsShare(share, {enabled: true});
    assert.equal(h.calls.length, 2);
});

test("verified HTTP redirect resolves the supplied Threads regression without reading HTML", async () => {
    const input = "https://www.threads.com/share/DinjQipPA/";
    let cancelled = false;
    const h = resolver(async () => response("", {
        redirected: true,
        url: "https://www.threads.com/@ioichon/post/DdYKhJvk0rW?xmt=test",
        body: {cancel: async () => { cancelled = true; }, getReader() { throw new Error("No body read required"); }}
    }));
    const result = await h.api.resolveThreadsShare(input, {force: true});
    assert.equal(result.output, "https://threads.com/@ioichon/post/DdYKhJvk0rW");
    assert.equal(result.resolved, true);
    assert.equal(cancelled, true);
    assert.equal(h.calls[0][0], input);
});

for (const url of ["https://other.test/@user/post/Ab", "http://threads.com/@user/post/Ab",
    "https://user@threads.com/@user/post/Ab", "https://threads.com:444/@user/post/Ab",
    "https://threads.com/login", "https://threads.com/share/Other"]) {
    test(`unverified redirect destination stays unchanged: ${url}`, async () => {
        const h = resolver(async () => response(html, {redirected: true, url}));
        assert.equal((await h.api.resolveThreadsShare(share, {force: true})).safe, false);
    });
}

test("off settings and unloaded settings bypass network and cache unless explicitly forced", async () => {
    const h = resolver(async () => response());
    assert.equal((await h.api.resolveThreadsShare(share)).output, share);
    assert.equal((await h.api.resolveThreadsShare(share, {enabled: false})).safe, false);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.api.resolveThreadsShare(share, {enabled: false, force: true})).output, post);
    assert.equal(h.calls.length, 1);
    assert.equal((await h.api.resolveThreadsShare(share, {enabled: false})).output, share);
});

test("pending resolution is deduplicated and independent result copies are returned", async () => {
    let finish;
    const h = resolver(() => new Promise(resolve => { finish = resolve; }));
    const first = h.api.resolveThreadsShare(share, {enabled: true});
    const second = h.api.resolveThreadsShare(share, {enabled: true});
    assert.equal(h.calls.length, 1);
    finish(response());
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.output, post);
    assert.equal(b.output, post);
    assert.notEqual(a, b);
});

for (const [name, getResponse] of [
    ["network failure", () => { throw new Error("Offline"); }],
    ["HTTP error", () => response(html, {ok: false, status: 429})],
    ["opaque response", () => response(html, {type: "opaque"})],
    ["redirected response", () => response(html, {redirected: true})],
    ["different response URL", () => response(html, {url: "https://other.test/"})],
    ["login response", () => response("<html><head><title>Sign in</title></head></html>")],
    ["non-HTML response", () => response(html, {headers: new Headers({"content-type": "application/json"})})],
    ["conflicting metadata", () => response(`<head><link rel="canonical" href="${post}"><meta property="og:url" content="https://threads.com/@user/post/Post_2"></head>`)],
    ["unverifiable canonical", () => response(`<head><link rel="canonical" href="/post/Post_1"></head>`)],
    ["metadata outside head", () => response(`<head></head><body><link rel="canonical" href="${post}"></body>`)],
    ["duplicate canonical attributes", () => response(`<head><link rel="canonical" href="${post}" href="${post}"></head>`)],
    ["oversized declared body", () => response(html, {headers: new Headers({"content-type": "text/html", "content-length": "524289"})})],
    ["oversized streamed body", () => response(" ".repeat(524289) + html)],
    ["unreadable body", () => response(html, {body: null})]
]) {
    test(`${name} preserves original with negative backoff and no fallback request`, async () => {
        const h = resolver(async () => getResponse());
        for (let index = 0; index < 2; index += 1) {
            const result = await h.api.resolveThreadsShare(share, {enabled: true});
            assert.equal(result.output, share);
            assert.equal(result.safe, false);
            assert.equal(result.resolved, false);
        }
        assert.equal(h.calls.length, 1);
        h.advance(15001);
        await h.api.resolveThreadsShare(share, {enabled: true});
        assert.equal(h.calls.length, 2);
    });
}

test("request timeout and stalled reading settle without relying on fetch abort", async () => {
    for (const stalledBody of [false, true]) {
        let expire;
        const h = resolver(async () => stalledBody ? response(html, {body: {
            getReader() { return {read: () => new Promise(() => {}), cancel() {}, releaseLock() {}}; }
        }}) : new Promise(() => {}), {
            setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {}
        });
        const pending = h.api.resolveThreadsShare(share, {enabled: true});
        await Promise.resolve();
        expire();
        assert.equal((await pending).output, share);
        assert.equal(h.calls[0][1].signal.aborted, true);
        assert.equal(h.calls.length, 1);
    }
});

test("cache and simultaneous request count are bounded", async () => {
    const h = resolver(async url => response(html, {url}));
    for (let index = 0; index < 101; index += 1) {
        await h.api.resolveThreadsShare(`https://threads.com/share/Item_${index}`, {enabled: true});
    }
    assert.equal(h.api.cached("https://threads.com/share/Item_0"), null);
    assert.equal(h.api.cached("https://threads.com/share/Item_100").output, post);
    const finish = [];
    const pendingHarness = resolver(url => new Promise(resolve => finish.push(() => resolve(response(html, {url})))));
    const pending = Array.from({length: 17}, (_, index) => pendingHarness.api.resolveThreadsShare(
        `https://threads.com/share/Item_${index}`, {enabled: true}));
    assert.equal(pendingHarness.calls.length, 16);
    assert.equal((await pending[16]).safe, false);
    finish.forEach(resolve => resolve());
    await Promise.all(pending);
});
