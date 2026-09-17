const assert = require("node:assert/strict");
const {test} = require("node:test");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {runInNewContext} = require("node:vm");

function harness(settings = {enabled: true, pasteClean: false, referralMarketing: false}) {
    const listeners = new Map();
    let storageListeners = [];
    const messages = [];
    const context = {
        URL, Blob,
        navigator: {},
        location: {href: "https://example.com/page"},
        document: {addEventListener(type, fn) { listeners.set(`document:${type}`, fn); }, activeElement: null},
        addEventListener(type, fn) { listeners.set(`window:${type}`, fn); },
        postMessage(message) { messages.push(message); },
        chrome: {
            runtime: {sendMessage: async message => { messages.push({runtime: message}); return {ok: true}; }},
            storage: {
                local: {
                    get: async () => ({...settings}),
                    },
                onChanged: {addListener(fn) { storageListeners.push(fn); }}
            }
        },
        CLEAN_URLS_RULES: {providers: {globalRules: {rules: ["fbclid"]}}}
    };
    context.window = context;
    for (const file of ["cleaner.js", "special_urls.js", "content_copy_cleaner.js"]) {
        runInNewContext(readFileSync(join(__dirname, file), "utf8"), context);
    }
    const deliverSettings = next => storageListeners.forEach(fn =>
        fn(Object.fromEntries(Object.entries(next).map(([key, value]) => ([key, {newValue: value}]))), "local"));
    return {
        context, messages, deliverSettings,
        copy(eventPatch = {}) {
            const listener = listeners.get("document:copy");
            assert.ok(listener, "copy listener installed");
            const data = {
                types: ["text/plain"],
                setData(type, value) { data.written = {type, value}; }
            };
            const event = {
                cancelable: true, defaultPrevented: false, target: null, composedPath: () => [],
                clipboardData: data, preventDefault() { event.defaultPrevented = true; }
            };
            if (eventPatch.types) data.types = eventPatch.types;
            listener(event);
            return event;
        },
        selectAndCopy(text, eventPatch = {}) {
            const parent = {closest: () => null};
            const textNode = {nodeType: 3, parentElement: parent};
            const range = {startContainer: textNode, endContainer: textNode};
            const selection = {rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => text};
            context.getSelection = () => selection;
            return this.copy(eventPatch);
        }
    };
}

test("selected plain tracking URL is cleaned on copy and default is prevented", () => {
    const h = harness();
    h.deliverSettings({enabled: true, pasteClean: false, referralMarketing: false});
    const event = h.selectAndCopy("https://example.com/?fbclid=x");
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.clipboardData.written.value, "https://example.com/");
});

test("non-URL selection and rich copy payloads pass through untouched", () => {
    const h = harness();
    h.deliverSettings({enabled: true, pasteClean: false, referralMarketing: false});
    const text = h.selectAndCopy("just some words");
    assert.equal(text.defaultPrevented, false);
    assert.equal(text.clipboardData.written, undefined);
    const rich = h.selectAndCopy("https://example.com/?fbclid=x", {types: ["text/plain", "text/html"]});
    assert.equal(rich.defaultPrevented, false);
});

test("selected URL cleaner retains the page sourceURL option", () => {
    const h = harness();
    h.deliverSettings({enabled: true});
    let sourceURL;
    h.context.CleanURLs.cleanURL = (input, options) => {
        sourceURL = options.sourceURL;
        return {input, output: input, changed: false, safe: true};
    };
    h.selectAndCopy("https://example.com/?fbclid=x");
    assert.equal(sourceURL, "https://example.com/page");
});

test("disabled master switch leaves copy untouched", () => {
    const h = harness({enabled: false, pasteClean: false, referralMarketing: false});
    h.deliverSettings({enabled: false, pasteClean: false, referralMarketing: false});
    const event = h.selectAndCopy("https://example.com/?fbclid=x");
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.clipboardData.written, undefined);
});
