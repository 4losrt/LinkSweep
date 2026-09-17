const assert = require("node:assert/strict");
const {test} = require("node:test");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {runInNewContext} = require("node:vm");

const share = "https://www.threads.com/share/Ab_12/";
const post = "https://threads.com/@user/post/Post_1";
const local = "https://example.com/?fbclid=x";
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (input = share) => ({input, output: post, resolvedURL: post, safe: true, resolved: true});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function harness(options = {}) {
    const messages = [];
    const requests = [];
    const writes = [];
    const timers = new Map();
    let nextTimer = 0;
    const clocks = {
        setTimeout(fn, delay) { timers.set(++nextTimer, {fn, delay}); return nextTimer; },
        clearTimeout(id) { timers.delete(id); }
    };
    const deliver = (context, data, source = true) => {
        context.message = data;
        context.sameSource = source;
        runInNewContext("onMessage({source: sameSource ? window : {}, data: message})", context);
    };
    class Item {
        constructor(values, settings = {}) {
            if (options.constructorFailure) throw options.constructorFailure;
            this.values = values;
            this.types = Object.keys(values);
            this.presentationStyle = settings.presentationStyle;
        }
        getType(type) { return Promise.resolve(this.values[type]); }
    }
    let main;
    const isolated = {
        URL, Blob, ...clocks,
        document: {activeElement: null, addEventListener() {}},
        location: {href: "https://www.threads.com/"},
        addEventListener(type, fn) { if (type === "message") this.onMessage = fn; },
        postMessage(message) {
            messages.push(message);
            if (options.bridge !== false) deliver(main, message);
        },
        chrome: {
            storage: {
                local: {get: async () => ({enabled: options.enabled !== false, pasteClean: false})},
                onChanged: {addListener(fn) { isolated.change = fn; }}
            },
            runtime: {sendMessage(message) {
                requests.push(message);
                return options.resolve ? options.resolve(message) : Promise.resolve(result(message.url));
            }}
        },
        CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}
    };
    const clipboard = {
        writeText(...args) {
            const promise = Promise.resolve();
            writes.push({method: "text", args, promise});
            return promise;
        },
        write(items, ...args) {
            const entry = {method: "items", items, args};
            writes.push(entry);
            if (options.nativeThrow) throw options.nativeThrow;
            entry.blob = items[0].types.length === 1 ? items[0].getType("text/plain") : Promise.resolve(null);
            entry.blob.catch(() => {});
            entry.promise = options.nativePromise || entry.blob.then(() => {});
            entry.promise.catch(() => {});
            return entry.promise;
        }
    };
    if (options.noWrite) delete clipboard.write;
    main = {
        URL, Blob: options.noBlob ? undefined : Blob, ...clocks,
        ClipboardItem: options.noItem ? undefined : Item,
        navigator: {clipboard}, location: {href: "https://www.threads.com/"},
        history: {replaceState() {}},
        document: {title: "Threads", addEventListener() {}, querySelectorAll() { throw new Error("No DOM context"); }},
        addEventListener(type, fn) { if (type === "message") this.onMessage = fn; },
        postMessage(message) {
            messages.push(message);
            if (options.bridge !== false) deliver(isolated, message);
        },
        CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}
    };
    for (const [context, file] of [[main, "navigation_main.js"], [isolated, "content_copy_cleaner.js"]]) {
        context.window = context;
        for (const name of ["cleaner.js", "special_urls.js", file]) {
            runInNewContext(readFileSync(join(__dirname, name), "utf8"), context);
        }
    }
    const settings = enabled => deliver(main, {source: "clean-urls-copy", type: "settings", enabled});
    const reply = (request, value, patch = {}, source = true) => deliver(main, {
        source: "clean-urls-copy", type: "clipboard-resolve-result",
        requestId: request.requestId, input: request.input, result: value, ...patch
    }, source);
    return {main, isolated, clipboard, writes, messages, requests, timers, settings, reply,
        send: (data, source = true) => deliver(isolated, data, source),
        ready: async () => { await flush(); if (options.bridge === false) settings(options.enabled !== false); },
        expire() { for (const timer of [...timers.values()]) { assert.equal(timer.delay, 6000); timer.fn(); } }
    };
}

function request(h) {
    return h.messages.filter(message => message.type === "clipboard-resolve-request").at(-1);
}

function pure(blob, presentationStyle = "attachment") {
    return {types: ["text/plain"], presentationStyle, getType: () => Promise.resolve(blob)};
}

test("Threads writeText calls native write synchronously and resolves only through isolated runtime verification", async () => {
    const pending = deferred();
    const h = harness({resolve: () => pending.promise});
    await h.ready();
    const written = h.clipboard.writeText(share);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].method, "items");
    assert.equal(written, h.writes[0].promise);
    assert.equal(h.requests.length, 0);
    let settled = false;
    h.writes[0].blob.then(() => { settled = true; });
    await flush();
    assert.equal(settled, false);
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests)), [{type: "resolveSpecialURL", url: share}]);
    pending.resolve(result());
    await written;
    assert.equal(await (await h.writes[0].blob).text(), post);
    const response = h.messages.find(message => message.type === "clipboard-resolve-result");
    assert.equal(response.requestId, request(h).requestId);
    assert.equal(response.input, share);
    assert.equal(response.result.resolvedURL, undefined);
    assert.equal(h.requests.length, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.timers.size, 0);
});

test("pure ClipboardItem has Threads parity and preserves presentationStyle", async () => {
    const h = harness();
    await h.ready();
    const original = new Blob([share], {type: "text/plain"});
    const written = h.clipboard.write([pure(original)], "native-extra");
    assert.equal(h.writes.length, 1);
    assert.equal(written, h.writes[0].promise);
    assert.equal(h.writes[0].items[0].presentationStyle, "attachment");
    assert.deepEqual(h.writes[0].args, ["native-extra"]);
    await written;
    assert.equal(await (await h.writes[0].blob).text(), post);
    assert.equal(h.requests.length, 1);
});

for (const kind of ["normal", "rich", "multiple", "non-string", "missing", "new-share"]) {
    test(`new ${kind} write cancels pending Threads Blob with AbortError`, async () => {
        const h = harness({bridge: false});
        await h.ready();
        h.clipboard.writeText(share);
        const first = h.writes[0];
        const stale = request(h);
        let replacement;
        if (kind === "rich" || kind === "multiple") {
            const item = {types: ["text/plain", "text/html"], getType() { throw new Error("Do not read rich data"); }};
            replacement = kind === "rich" ? [item] : [item, item];
            h.clipboard.write(replacement);
            assert.equal(h.writes[1].items, replacement);
        } else if (kind === "missing") h.clipboard.writeText();
        else h.clipboard.writeText(kind === "normal" ? local : kind === "new-share" ? share : {});
        await assert.rejects(first.blob, {name: "AbortError"});
        h.reply(stale, {...result(), changed: true});
        if (kind === "new-share") {
            assert.ok(request(h).requestId > stale.requestId);
            h.reply(request(h), {...result(), changed: true});
            assert.equal(await (await h.writes[1].blob).text(), post);
        }
        h.expire();
        await flush();
        assert.equal(h.writes.length, 2);
        if (kind === "normal") assert.equal(h.writes[1].args[0], "https://example.com/");
    });
}

test("new write cancels pure item while getType or text is still pending", async () => {
    for (const stage of ["getType", "text"]) {
        const pending = deferred();
        const h = harness();
        await h.ready();
        const item = stage === "getType" ? {types: ["text/plain"], getType: () => pending.promise}
            : pure({text: () => pending.promise});
        h.clipboard.write([item]);
        await flush();
        h.clipboard.writeText("new text");
        await assert.rejects(h.writes[0].blob, {name: "AbortError"});
        pending.resolve(stage === "getType" ? new Blob([share]) : share);
        await flush();
        assert.equal(h.requests.length, 0);
        assert.equal(h.writes.length, 2);
    }
});

test("6000ms timeout settles only current Blob to original without another native call", async () => {
    for (const item of [false, true]) {
        const h = harness({bridge: false});
        await h.ready();
        const original = new Blob([share], {type: "text/plain"});
        const written = item ? h.clipboard.write([pure(original)]) : h.clipboard.writeText(share);
        await flush();
        const stale = request(h);
        h.expire();
        await written;
        const blob = await h.writes[0].blob;
        assert.equal(await blob.text(), share);
        if (item) assert.equal(blob, original);
        h.reply(stale, {...result(), changed: true});
        assert.equal(h.writes.length, 1);
        assert.equal(h.timers.size, 0);
    }
});

test("wrong correlation, source and malformed MAIN results remain pending", async () => {
    const h = harness({bridge: false});
    await h.ready();
    h.clipboard.writeText(share);
    const current = request(h);
    const valid = {...result(), changed: true};
    let settled = false;
    h.writes[0].blob.then(() => { settled = true; });
    h.reply(current, valid, {requestId: String(current.requestId)});
    h.reply(current, valid, {input: `${share}?x=1`});
    h.reply(current, valid, {source: "other"});
    h.reply(current, valid, {}, false);
    for (const patch of [{input: "wrong"}, {safe: false}, {resolved: false}, {changed: false},
        {output: "https://evil.example/post/id"}, {output: `${post}?x=1`}, {output: `${post}/`},
        {output: "https://threads.com/share/id"}, {output: "https://user@threads.com/post/id"}]) {
        h.reply(current, {...valid, ...patch});
    }
    await flush();
    assert.equal(settled, false);
    h.reply(current, valid);
    assert.equal(await (await h.writes[0].blob).text(), post);
});

test("disabled settings abort pending resolution and never force runtime resolution", async () => {
    const pending = deferred();
    const h = harness({resolve: () => pending.promise});
    h.clipboard.writeText(share);
    assert.equal(h.writes[0].method, "text");
    await h.ready();
    h.clipboard.writeText(share);
    await flush();
    h.isolated.change({enabled: {newValue: false}}, "local");
    await assert.rejects(h.writes[1].blob, {name: "AbortError"});
    pending.resolve(result());
    await flush();
    h.clipboard.writeText(share);
    assert.equal(h.writes[2].args[0], share);
    assert.equal(h.messages.filter(message => message.type === "clipboard-resolve-result").length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].manual, undefined);
    assert.equal(h.requests[0].force, undefined);
    assert.equal(h.timers.size, 0);
});

for (const option of ["noWrite", "noItem", "noBlob", "constructorFailure"]) {
    test(`${option} falls back immediately to original native writeText`, async () => {
        const h = harness({[option]: option === "constructorFailure" ? new Error("Unsupported") : true});
        await h.ready();
        const written = h.clipboard.writeText(share);
        assert.equal(h.writes.length, 1);
        assert.equal(h.writes[0].method, "text");
        assert.equal(h.writes[0].args[0], share);
        assert.equal(written, h.writes[0].promise);
        await flush();
        assert.equal(h.requests.length, 0);
        assert.equal(h.timers.size, 0);
    });
}

test("native throw and rejection are preserved with no fallback after attempted write", async () => {
    const failure = new Error("Native denied");
    const sync = harness({nativeThrow: failure});
    await sync.ready();
    assert.throws(() => sync.clipboard.writeText(share), error => error === failure);
    assert.equal(sync.writes.length, 1);
    assert.equal(sync.requests.length, 0);
    assert.equal(sync.timers.size, 0);
    const native = deferred();
    const h = harness({bridge: false, nativePromise: native.promise});
    await h.ready();
    assert.equal(h.clipboard.writeText(share), native.promise);
    native.reject(failure);
    await assert.rejects(native.promise, error => error === failure);
    await assert.rejects(h.writes[0].blob, error => error === failure);
    h.reply(request(h), {...result(), changed: true});
    h.expire();
    assert.equal(h.writes.length, 1);
    assert.equal(h.timers.size, 0);
});

test("isolated rejects unverified resolver results and failure cache avoids another fetch", async () => {
    for (const invalid of [null, {...result(), input: "wrong"}, {...result(), safe: false},
        {...result(), resolved: false}, {...result(), resolvedURL: "https://evil.example/"},
        {...result(), output: `${post}?fbclid=x`}]) {
        const h = harness({resolve: () => Promise.resolve(invalid)});
        await h.ready();
        await h.clipboard.writeText(share);
        assert.equal(await (await h.writes[0].blob).text(), share);
        await h.clipboard.writeText(share);
        assert.equal(h.requests.length, 1);
        assert.equal(h.messages.find(message => message.type === "clipboard-resolve-result").result, null);
    }
});

test("isolated shares pending prefetch, bounds requests and skips untrusted Threads commits", async () => {
    const pending = deferred();
    const h = harness({resolve: () => pending.promise});
    await h.ready();
    h.send({source: "clean-urls-copy-navigation", type: "prefetch-special", value: share});
    for (let index = 0; index < 100; index += 1) h.clipboard.writeText(share);
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.size, 2);
    pending.resolve(result());
    await h.writes.at(-1).promise;
    assert.equal(h.messages.filter(message => message.type === "clipboard-resolve-result").length, 1);
    await h.clipboard.writeText(share);
    assert.equal(h.requests.length, 1);
    h.send({source: "clean-urls-copy-navigation", type: "clipboard-committed", before: share,
        after: post, resolved: true, removed: ["fake"]});
    await flush();
    assert.equal(h.requests.length, 1);
});

test("isolated validates requests, forwards only known fields and bounds distinct pending URLs", async () => {
    const h = harness({bridge: false, resolve: () => new Promise(() => {})});
    await h.ready();
    const base = {source: "clean-urls-copy-navigation", type: "clipboard-resolve-request", requestId: 1, input: share};
    for (const patch of [{requestId: "1"}, {requestId: -1}, {requestId: 1.5}, {requestId: Infinity},
        {input: "https://evil.example/"}, {input: `${share}${"x".repeat(8192)}`}, {source: "other"}]) {
        h.send({...base, ...patch});
    }
    h.send(base, false);
    await flush();
    assert.equal(h.requests.length, 0);
    for (let index = 1; index <= 100; index += 1) {
        h.send({...base, requestId: index, input: `https://threads.com/share/${index}/`, manual: true, force: true});
    }
    await flush();
    assert.equal(h.requests.length, 16);
    assert.equal(h.timers.size, 16);
    for (const message of h.requests) assert.deepEqual(Object.keys(message).sort(), ["type", "url"]);
    h.expire();
    await flush();
    assert.equal(h.timers.size, 0);
});

test("runtime rejection and synchronous runtime failure resolve the original Blob", async () => {
    for (const sync of [false, true]) {
        const h = harness({resolve() {
            if (sync) throw new Error("Runtime unavailable");
            return Promise.reject(new Error("Runtime unavailable"));
        }});
        await h.ready();
        await h.clipboard.writeText(share);
        assert.equal(await (await h.writes[0].blob).text(), share);
        assert.equal(h.writes.length, 1);
        assert.equal(h.timers.size, 0);
    }
});

test("pending pure item reads are bounded even before an original Blob is available", async () => {
    const h = harness();
    await h.ready();
    h.clipboard.write([{types: ["text/plain"], getType: () => new Promise(() => {})}]);
    await flush();
    h.expire();
    await assert.rejects(h.writes[0].blob, {name: "AbortError"});
    assert.equal(h.timers.size, 0);
    assert.equal(h.requests.length, 0);
});

test("late resolver success after timeout cannot change the original committed payload", async () => {
    const pending = deferred();
    const h = harness({resolve: () => pending.promise});
    await h.ready();
    const written = h.clipboard.writeText(share);
    await flush();
    h.expire();
    await written;
    pending.resolve(result());
    await flush();
    assert.equal(await (await h.writes[0].blob).text(), share);
    assert.equal(h.writes.length, 1);
    assert.equal(h.timers.size, 0);
});

test("old request IDs are ignored and settings invalidation cannot reuse stale results", async () => {
    const first = deferred();
    let calls = 0;
    const h = harness({resolve: () => ++calls === 1 ? first.promise : Promise.resolve(result())});
    await h.ready();
    h.clipboard.writeText(share);
    await flush();
    const stale = request(h);
    h.send(stale);
    await flush();
    assert.equal(h.requests.length, 1);
    h.isolated.change({enabled: {newValue: false}}, "local");
    await assert.rejects(h.writes[0].blob, {name: "AbortError"});
    h.isolated.change({enabled: {newValue: true}}, "local");
    await h.clipboard.writeText(share);
    first.resolve({...result(), output: "https://threads.com/post/stale", resolvedURL: "https://threads.com/post/stale"});
    await flush();
    assert.equal(await (await h.writes[1].blob).text(), post);
    assert.equal(h.requests.length, 2);
    assert.equal(h.messages.filter(message => message.type === "clipboard-resolve-result").length, 1);
});

test("local cleaner preserves sourceURL options for immediate text and pure items", async () => {
    const h = harness();
    await h.ready();
    const seen = [];
    h.main.CleanURLs.cleanURL = (input, options) => {
        seen.push(options.sourceURL);
        return {input, output: input, changed: false, safe: true};
    };
    h.clipboard.writeText(local);
    await h.clipboard.write([pure(new Blob([local]))]);
    assert.deepEqual(seen, ["https://www.threads.com/", "https://www.threads.com/"]);
});
