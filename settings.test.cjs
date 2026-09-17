const assert = require("node:assert/strict");
const {test} = require("node:test");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {runInNewContext} = require("node:vm");

const input = "https://example.com/?fbclid=x";
const output = "https://example.com/";
const share = "https://www.threads.com/share/Ab_12/";
const post = "https://www.threads.com/@user/post/Post_1";
const flush = () => new Promise(resolve => setImmediate(resolve));
const source = file => readFileSync(join(__dirname, file), "utf8");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function background(stored = {}, options = {}) {
    const data = {...stored};
    const patches = [];
    const configurations = [];
    const resolutions = [];
    const events = {};
    let messageListener;
    let storageListener;
    let exists = Boolean(options.exists);
    let creates = 0;
    const chrome = {
        runtime: {
            id: "test",
            getURL: path => `chrome-extension://test/${path}`,
            onMessage: {addListener(fn) { messageListener = fn; }},
            onInstalled: {addListener(fn) { events.installed = fn; }},
            onStartup: {addListener(fn) { events.startup = fn; }},
            async sendMessage(message) { configurations.push(message); }
        },
        storage: {
            local: {
                async get(defaults) { return {...defaults, ...data}; },
                async set(patch) {
                    if (options.beforeSet) await options.beforeSet(patch);
                    patches.push({...patch});
                    const changes = {};
                    for (const [key, newValue] of Object.entries(patch)) {
                        if (data[key] !== newValue) changes[key] = {oldValue: data[key], newValue};
                        data[key] = newValue;
                    }
                    storageListener?.(changes, "local");
                }
            },
            onChanged: {addListener(fn) { storageListener = fn; }}
        },
        offscreen: {
            async hasDocument() { return exists; },
            async createDocument() {
                creates += 1;
                if (options.create) await options.create();
                exists = true;
            },
            async closeDocument() { exists = false; }
        },
        action: {async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {}},
        contextMenus: {async removeAll() {}, async create() {}, onClicked: {addListener() {}}}
    };
    const context = {URL, chrome, importScripts() {}, CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}};
    runInNewContext(source("cleaner.js"), context);
    runInNewContext(source("special_urls.js"), context);
    context.CleanURLsSpecialResolver = {async resolveThreadsShare(url, settings) {
        resolutions.push({url, settings});
        return {input: url, output: post, changed: true, resolved: true, safe: true, removed: []};
    }};
    runInNewContext(source("background.js"), context);
    const request = message => new Promise(resolve => {
        messageListener(message, {id: "test", url: chrome.runtime.getURL("popup.html")}, resolve);
    });
    return {data, patches, configurations, resolutions, events, chrome, context, request,
        get creates() { return creates; }, get exists() { return exists; }};
}

function plain(text = input) {
    return [{types: ["text/plain"], getType: async () => new Blob([text], {type: "text/plain"})}];
}

function offscreen(options = {}) {
    let listener;
    let tick;
    let reads = 0;
    let textReads = 0;
    const writes = [];
    const messages = [];
    const clipboard = {
        async read() { reads += 1; return options.read ? options.read(reads) : plain(); },
        async readText() { textReads += 1; throw new Error("No MIME-blind reads"); },
        async writeText(value) { writes.push(value); }
    };
    if (options.noRead) delete clipboard.read;
    const context = {URL, Blob, navigator: {clipboard},
        setInterval(fn) { tick = fn; return 1; }, clearInterval() { tick = null; },
        chrome: {runtime: {onMessage: {addListener(fn) { listener = fn; }},
            async sendMessage(message) {
                messages.push(message);
                return options.sendMessage?.(message);
            }}},
        CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}
    };
    context.window = context;
    for (const file of ["cleaner.js", "special_urls.js", "offscreen.js"]) runInNewContext(source(file), context);
    const configure = (settings = {enabled: true, pasteClean: true}) => listener({type: "offscreenConfigure", settings}, {}, () => {});
    return {configure, writes, messages, poll: () => tick?.(), get reads() { return reads; }, get textReads() { return textReads; }};
}

test("offscreen overlapping polls and disable/re-enable invalidate a stale read", async () => {
    const pending = deferred();
    const h = offscreen({read: count => count === 1 ? pending.promise : plain()});
    h.configure();
    h.poll();
    assert.equal(h.reads, 1);
    h.configure({enabled: true, pasteClean: false});
    h.configure();
    h.poll();
    assert.equal(h.reads, 1);
    pending.resolve(plain());
    await flush();
    assert.deepEqual(h.writes, []);
    h.poll();
    await flush();
    assert.deepEqual(h.writes, [output]);
});

test("offscreen settings change during final clipboard validation prevents stale write", async () => {
    const pending = deferred();
    const h = offscreen({read: count => count === 2 ? pending.promise : plain()});
    h.configure();
    await flush();
    assert.equal(h.reads, 2);
    h.configure({enabled: false, pasteClean: true});
    pending.resolve(plain());
    await flush();
    assert.deepEqual(h.writes, []);
});

test("migration serializes startup, install, reads and popup opt-in without resetting other settings", async () => {
    const migration = deferred();
    const h = background({pasteClean: true, enabled: false, referralMarketing: true, copiedCount: 9}, {
        beforeSet: patch => patch.pasteCleanOptInVersion ? migration.promise : undefined
    });
    const installed = h.events.installed();
    const startup = h.events.startup();
    const reads = [h.request({type: "getSettings"}), h.request({type: "getSettings"})];
    await flush();
    assert.equal(h.creates, 0);
    assert.equal(h.configurations.length, 0);
    const optIn = h.request({type: "setSetting", key: "pasteClean", value: true});
    migration.resolve();
    for (const settings of await Promise.all(reads)) assert.equal(settings.pasteClean, false);
    assert.equal((await optIn).pasteClean, true);
    await Promise.all([installed, startup]);
    assert.equal(h.patches.filter(patch => patch.pasteCleanOptInVersion).length, 1);
    assert.equal(h.data.enabled, false);
    assert.equal(h.data.referralMarketing, true);
    assert.equal(h.data.copiedCount, 9);
    assert.equal(h.data.pasteCleanOptInVersion, 1);
    const restarted = background(h.data);
    await restarted.events.installed();
    assert.equal((await restarted.request({type: "getSettings"})).pasteClean, true);
    assert.equal(restarted.patches.length, 0);
});

test("fresh install and legacy true both stay off through top-level synchronization", async () => {
    for (const initial of [{}, {pasteClean: true}]) {
        const h = background(initial);
        await h.events.installed();
        await h.request({type: "offscreenReady"});
        assert.equal(h.data.pasteClean, false);
        assert.equal(h.creates, 0);
        assert.equal(h.configurations.some(message => message.settings.enabled && message.settings.pasteClean), false);
    }
});

test("failed migration cannot enable monitoring and can retry", async () => {
    let fail = true;
    const h = background({pasteClean: true}, {beforeSet() { if (fail) throw new Error("Storage unavailable"); }});
    await assert.rejects(h.context.getSettings());
    await flush();
    assert.equal(h.creates, 0);
    fail = false;
    assert.equal((await h.context.getSettings()).pasteClean, false);
});

test("offscreen creation rechecks settings before configuring and closes on disable", async () => {
    const pending = deferred();
    const h = background({pasteClean: true, pasteCleanOptInVersion: 1}, {create: () => pending.promise});
    await flush();
    assert.equal(h.creates, 1);
    await h.request({type: "setSetting", key: "pasteClean", value: false});
    pending.resolve();
    await flush();
    assert.equal(h.exists, false);
    assert.equal(h.configurations.some(message => message.settings.enabled && message.settings.pasteClean), false);
});

test("automatic gates prevent local cleaning and Threads requests; explicit manual bypass remains", async () => {
    for (const settings of [{enabled: false, pasteClean: true}, {enabled: true, pasteClean: false}]) {
        const h = background({...settings, pasteCleanOptInVersion: 1});
        for (const url of [input, share]) {
            assert.equal((await h.request({type: "cleanClipboardURL", url})).output, url);
        }
        assert.equal(h.resolutions.length, 0);
        assert.equal((await h.request({type: "cleanClipboardURL", url: input, manual: true})).output, output);
        assert.equal((await h.request({type: "cleanURL", url: share, manual: true})).output, post);
        assert.equal(h.resolutions[0].settings.force, true);
    }
    const h = background({enabled: false, pasteCleanOptInVersion: 1});
    assert.equal((await h.request({type: "resolveSpecialURL", url: share})).output, share);
    assert.equal(h.resolutions.length, 0);
    const on = background({enabled: true, pasteClean: true, pasteCleanOptInVersion: 1});
    assert.equal((await on.request({type: "cleanClipboardURL", url: share})).output, post);
    assert.equal(on.resolutions[0].settings.force, false);
    assert.equal((await on.request({type: "setSetting", key: "pasteCleanOptInVersion", value: true})).error, "Setting not saved");
});

test("offscreen starts disabled and pure text is validated twice before writing", async () => {
    const h = offscreen();
    await flush();
    assert.equal(h.reads, 0);
    h.configure({enabled: true});
    await flush();
    assert.equal(h.reads, 0);
    h.configure();
    await flush();
    assert.equal(h.reads, 2);
    assert.deepEqual(h.writes, [output]);
    assert.equal(h.textReads, 0);
    assert.equal(h.messages.filter(message => message.type === "clipboardCleaned").length, 1);
});

for (const types of [["text/plain", "text/html"], ["image/png"], ["text/html"], []]) {
    test(`offscreen passes through MIME types ${types.join(",")}`, async () => {
        const h = offscreen({read: () => [{types, getType() { throw new Error("Must not read rich item"); }}]});
        h.configure();
        await flush();
        assert.equal(h.reads, 1);
        assert.deepEqual(h.writes, []);
        assert.equal(h.textReads, 0);
    });
}

for (const items of [[], [...plain(), ...plain()], [{types: ["text/plain"], getType: async () => new Blob([input], {type: "text/html"})}]]) {
    test("offscreen rejects empty/multiple items and mismatched Blob type", async () => {
        const h = offscreen({read: () => items});
        h.configure();
        await flush();
        assert.deepEqual(h.writes, []);
    });
}

test("offscreen never falls back to readText on unsupported or denied read", async () => {
    for (const options of [{noRead: true}, {read() { throw new Error("Denied"); }}]) {
        const h = offscreen(options);
        h.configure();
        await flush();
        assert.equal(h.textReads, 0);
        assert.deepEqual(h.writes, []);
    }
});

for (const replacement of [plain("https://other.test/"), plain(` ${input}`), [{types: ["text/plain", "text/html"]}], [...plain(), ...plain()]]) {
    test("offscreen revalidates exact text and formats immediately before write", async () => {
        const h = offscreen({read: count => count === 1 ? plain() : replacement});
        h.configure();
        await flush();
        assert.equal(h.reads, 2);
        assert.deepEqual(h.writes, []);
    });
}

test("offscreen generation guards Blob and text reads and delayed resolution", async () => {
    for (const stage of ["blob", "text", "resolve"]) {
        const pending = deferred();
        const item = {types: ["text/plain"], getType: () => stage === "blob" ? pending.promise
            : {type: "text/plain", text: () => pending.promise}};
        const h = offscreen({read: () => stage === "resolve" ? plain(share) : [item],
            sendMessage: message => message.type === "cleanClipboardURL" ? pending.promise : undefined});
        h.configure();
        await flush();
        h.configure({enabled: true, pasteClean: false});
        pending.resolve(stage === "blob" ? new Blob([input], {type: "text/plain"}) : stage === "text" ? input
            : {input: share, output: post, safe: true, changed: true});
        await flush();
        assert.deepEqual(h.writes, []);
        assert.equal(h.reads, 1);
    }
});

test("stored pasteClean false leaves automatic clipboard URLs untouched without resolution", async () => {
    const h = background({enabled: true, pasteClean: true, pasteCleanOptInVersion: 1});
    await h.request({type: "getSettings"});
    await h.chrome.storage.local.set({pasteClean: false});
    for (const url of [input, share]) {
        const result = await h.request({type: "cleanClipboardURL", url});
        assert.equal(result.output, url);
        assert.equal(result.changed, false);
    }
    assert.equal(h.resolutions.length, 0);
    await flush();
    assert.equal(h.exists, false);
});
