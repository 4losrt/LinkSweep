const assert = require("node:assert/strict");
const {test} = require("node:test");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {runInNewContext} = require("node:vm");

const input = "https://example.com/?fbclid=x";
const output = "https://example.com/";
const share = "https://www.threads.com/share/Ab_12/";
const post = "https://threads.com/@user/post/Post_1";
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function harness(options = {}) {
    const listeners = {};
    const documentListeners = {};
    const writes = [];
    const messages = [];
    const timers = [];
    const nativePromise = Promise.resolve();
    class Item {
        constructor(values, settings = {}) {
            this.values = values;
            this.types = Object.keys(values);
            this.presentationStyle = settings.presentationStyle || "unspecified";
        }
        getType(type) { return Promise.resolve(this.values[type]); }
    }
    const clipboard = {
        writeText(...args) {
            writes.push({method: "text", args});
            return options.writeText ? options.writeText(...args) : nativePromise;
        },
        write(items) {
            writes.push({method: "items", items});
            return options.write ? options.write(items) : nativePromise;
        }
    };
    const context = {URL, Blob, ClipboardItem: options.ClipboardItem || Item, navigator: {clipboard},
        location: {href: "https://example.com/"}, history: {replaceState() {}},
        document: {title: "Test", addEventListener(type, fn) { documentListeners[type] = fn; }},
        addEventListener(type, fn) { listeners[type] = fn; },
        postMessage(message) { messages.push(message); },
        open() {}, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
        CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}
    };
    context.window = context;
    for (const file of ["cleaner.js", "special_urls.js", "navigation_main.js"]) {
        runInNewContext(readFileSync(join(__dirname, file), "utf8"), context);
    }
    const settings = (enabled = true) => {
        context.settingsMessage = {source: "clean-urls-copy", type: "settings", enabled, pasteClean: false};
        context.deliver = listeners.message;
        runInNewContext("deliver({source: window, data: settingsMessage})", context);
    };
    return {context, clipboard, writes, messages, timers, settings, nativePromise, Item, documentListeners};
}

test("local and Threads native writes are immediate with no later clipboard call", async () => {
    const h = harness();
    h.settings();
    const first = h.clipboard.writeText(input);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].args[0], output);
    const second = h.clipboard.writeText(share);
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[1].method, "items");
    assert.equal(first, h.nativePromise);
    assert.equal(second, h.nativePromise);
    assert.equal(h.timers.length, 1);
    h.timers[0]();
    assert.equal(await (await h.writes[1].items[0].getType("text/plain")).text(), share);
    await flush();
    assert.equal(h.writes.length, 2);
    assert.equal(h.messages.filter(message => message.type === "clipboard-resolve-request").length, 1);
    assert.equal(h.messages.some(message => message.type === "clipboard-request"), false);
});

test("initially disabled, pasteClean false does not gate copying, and disabling takes effect", () => {
    const h = harness();
    h.clipboard.writeText(input);
    assert.equal(h.writes[0].args[0], input);
    h.settings();
    h.clipboard.writeText(input);
    assert.equal(h.writes[1].args[0], output);
    h.settings(false);
    h.clipboard.writeText(input);
    h.clipboard.writeText(share);
    assert.equal(h.writes[2].args[0], input);
    assert.equal(h.messages.some(message => message.type === "prefetch-special"), false);
});

test("native rejection and synchronous failure propagate without retries or success reports", async () => {
    const failure = new Error("Clipboard denied");
    const pending = deferred();
    const h = harness({writeText: () => pending.promise});
    h.settings();
    const written = h.clipboard.writeText(input);
    assert.equal(written, pending.promise);
    pending.reject(failure);
    await assert.rejects(written, error => error === failure);
    await flush();
    assert.equal(h.writes.length, 1);
    assert.equal(h.messages.some(message => message.type === "clipboard-committed"), false);
    const sync = harness({writeText() { throw failure; }});
    sync.settings();
    assert.throws(() => sync.clipboard.writeText(input), error => error === failure);
    assert.equal(sync.writes.length, 1);
});

test("non-string arguments, missing arguments and non-URL text retain native conversion", () => {
    const h = harness();
    h.settings();
    const value = {toString() { throw new Error("Do not coerce in wrapper"); }};
    h.clipboard.writeText(value);
    h.clipboard.writeText();
    h.clipboard.writeText(`${input} other text`);
    assert.equal(h.writes[0].args[0], value);
    assert.equal(h.writes[1].args.length, 0);
    assert.equal(h.writes[2].args[0], `${input} other text`);
});

test("pure ClipboardItem invokes native write immediately with promise data and presentationStyle", async () => {
    const h = harness();
    h.settings();
    const pending = deferred();
    let reads = 0;
    const item = {types: ["text/plain"], presentationStyle: "attachment", getType() { reads += 1; return pending.promise; }};
    const written = h.clipboard.write([item]);
    assert.equal(written, h.nativePromise);
    assert.equal(h.writes.length, 1);
    assert.equal(reads, 0);
    const replacement = h.writes[0].items[0];
    assert.equal(replacement.presentationStyle, "attachment");
    pending.resolve(new Blob([input], {type: "text/plain"}));
    assert.equal(await (await replacement.getType("text/plain")).text(), output);
    assert.equal(h.writes.length, 1);
});

test("mixed MIME, multiple items and disabled writes bypass unchanged without reading data", () => {
    const h = harness();
    h.settings();
    const item = {types: ["text/plain", "text/html"], getType() { throw new Error("Must not read rich data"); }};
    const mixed = [item];
    const multiple = [item, item];
    h.clipboard.write(mixed);
    h.clipboard.write(multiple);
    h.settings(false);
    const plain = [new h.Item({"text/plain": new Blob([input])})];
    h.clipboard.write(plain);
    assert.equal(h.writes[0].items, mixed);
    assert.equal(h.writes[1].items, multiple);
    assert.equal(h.writes[2].items, plain);
});

test("ClipboardItem constructor fallback is immediate and native write failure is not retried", async () => {
    const h = harness({ClipboardItem: class { constructor() { throw new Error("Unsupported promise data"); } }});
    h.settings();
    const items = [new h.Item({"text/plain": new Blob([input])})];
    h.clipboard.write(items);
    assert.equal(h.writes[0].items, items);
    const failure = new Error("Write failed");
    const failed = harness({write() { throw failure; }});
    failed.settings();
    assert.throws(() => failed.clipboard.write([new failed.Item({"text/plain": new Blob([input])})]), error => error === failure);
    await flush();
    assert.equal(failed.writes.length, 1);
});

test("item data rejection propagates and unreadable text preserves original Blob", async () => {
    const h = harness();
    h.settings();
    const failure = new Error("Read denied");
    h.clipboard.write([{types: ["text/plain"], getType() { return Promise.reject(failure); }}]);
    await assert.rejects(h.writes[0].items[0].getType("text/plain"), error => error === failure);
    const original = {text: () => Promise.reject(failure)};
    h.clipboard.write([{types: ["text/plain"], getType: () => original}]);
    assert.equal(await h.writes[1].items[0].getType("text/plain"), original);
});

test("Threads copy never reads recent DOM post context", async () => {
    const h = harness();
    h.settings();
    const target = {closest(selector) {
        assert.equal(selector, "a[href], area[href]");
        return null;
    }, querySelectorAll() { throw new Error("Must not inspect nearby posts"); }};
    h.documentListeners.click({type: "click", button: 0, target, composedPath: () => [target]});
    h.clipboard.writeText(share);
    h.clipboard.write([new h.Item({"text/plain": new Blob([share])})]);
    await assert.rejects(h.writes[0].items[0].getType("text/plain"), {name: "AbortError"});
    await flush();
    h.timers[1]();
    assert.equal(await (await h.writes[1].items[0].getType("text/plain")).text(), share);
});

function isolated(options = {}) {
    const documentListeners = {};
    const listeners = {};
    const storage = deferred();
    const requests = [];
    const messages = [];
    let storageListener;
    const parent = {closest: () => null};
    const text = {nodeType: 3, parentElement: parent};
    const selection = {rangeCount: 1, isCollapsed: false, toString: () => input,
        getRangeAt: () => ({startContainer: text, endContainer: text})};
    const context = {URL, setTimeout, clearTimeout,
        document: {activeElement: null, addEventListener(type, fn) { documentListeners[type] = fn; }},
        getSelection: () => selection,
        addEventListener(type, fn) { listeners[type] = fn; },
        postMessage(message) { messages.push(message); },
        chrome: {storage: {local: {get: () => storage.promise}, onChanged: {addListener(fn) { storageListener = fn; }}},
            runtime: {sendMessage(message) { requests.push(message); return options.sendMessage?.(message) ?? Promise.resolve(null); }}},
        CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}
    };
    context.window = context;
    for (const file of ["cleaner.js", "special_urls.js", "content_copy_cleaner.js"]) {
        runInNewContext(readFileSync(join(__dirname, file), "utf8"), context);
    }
    const copy = (overrides = {}) => {
        const data = [];
        const event = {cancelable: true, defaultPrevented: false, target: parent,
            clipboardData: {types: [], setData: (...args) => data.push(args)},
            preventDefault() { this.defaultPrevented = true; }, ...overrides};
        documentListeners.copy(event);
        return {event, data};
    };
    const ready = async (enabled = true) => { storage.resolve({enabled, pasteClean: false}); await flush(); };
    return {context, documentListeners, listeners, storage, requests, messages, parent, text, selection, copy, ready,
        change: (changes, area = "local") => storageListener(changes, area)};
}

test("isolated copy is disabled until loaded and is independent of passive clipboard setting", async () => {
    const h = isolated();
    assert.equal(h.copy().event.defaultPrevented, false);
    await h.ready();
    assert.deepEqual(h.copy().data, [["text/plain", output]]);
    h.change({enabled: {newValue: false}});
    assert.equal(h.copy().event.defaultPrevented, false);
});

test("isolated copy preserves rich, editable, multi-node and non-URL selections", async () => {
    const h = isolated();
    await h.ready();
    assert.equal(h.copy({clipboardData: {types: ["text/plain", "text/html"], setData() { throw new Error("No write"); }}}).event.defaultPrevented, false);
    h.context.document.activeElement = {isContentEditable: true};
    assert.equal(h.copy().event.defaultPrevented, false);
    h.context.document.activeElement = null;
    h.parent.closest = () => ({});
    assert.equal(h.copy().event.defaultPrevented, false);
    h.parent.closest = () => null;
    h.selection.getRangeAt = () => ({startContainer: h.text, endContainer: {nodeType: 3}});
    assert.equal(h.copy().event.defaultPrevented, false);
    h.selection.getRangeAt = () => ({startContainer: h.text, endContainer: h.text});
    h.selection.toString = () => `${input} other text`;
    assert.equal(h.copy().event.defaultPrevented, false);
    h.selection.toString = () => "";
    h.context.document.activeElement = {href: input, closest: () => ({href: input})};
    assert.equal(h.copy().event.defaultPrevented, false);
});

test("copy-event write failure leaves default behavior intact", async () => {
    const h = isolated();
    await h.ready();
    const result = h.copy({clipboardData: {types: [], setData() { throw new Error("Write denied"); }}});
    assert.equal(result.event.defaultPrevented, false);
});

test("isolated Threads prefetch only benefits future explicit copy operations", async () => {
    const pending = deferred();
    const h = isolated({sendMessage: message => message.type === "resolveSpecialURL" ? pending.promise : Promise.resolve()});
    await h.ready();
    h.selection.toString = () => share;
    const first = h.copy();
    const second = h.copy();
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(first.event.defaultPrevented, false);
    assert.equal(second.event.defaultPrevented, false);
    pending.resolve({input: share, output: post, resolvedURL: post, safe: true, resolved: true});
    await flush();
    assert.equal(first.data.length, 0);
    assert.deepEqual(h.copy().data, [["text/plain", post]]);
    assert.equal(h.messages.some(message => message.type === "resolved-cache"), false);
});

test("automatic hover and selection prefetch respect disabled settings", async () => {
    const h = isolated();
    h.selection.toString = () => share;
    const event = {target: {closest: selector => selector === "a[href], area[href]" ? {href: share} : null}};
    h.documentListeners.pointerover(event);
    h.documentListeners.selectionchange();
    await h.ready(false);
    h.documentListeners.pointerover(event);
    h.documentListeners.focusin(event);
    h.documentListeners.selectionchange();
    await flush();
    assert.equal(h.requests.length, 0);
});

test("settings changes invalidate pending resolution and stale initial settings", async () => {
    const pending = deferred();
    const h = isolated({sendMessage: () => pending.promise});
    await h.ready();
    h.selection.toString = () => share;
    h.copy();
    await flush();
    h.change({enabled: {newValue: false}});
    pending.resolve({input: share, output: post, resolvedURL: post, safe: true, resolved: true});
    await flush();
    h.change({enabled: {newValue: true}});
    assert.equal(h.copy().event.defaultPrevented, false);
    await flush();
    const stale = isolated();
    stale.change({enabled: {newValue: false}});
    await stale.ready(true);
    assert.equal(stale.copy().event.defaultPrevented, false);
});
