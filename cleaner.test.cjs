const assert = require("node:assert/strict");
const {test} = require("node:test");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {runInNewContext} = require("node:vm");
const {execFileSync} = require("node:child_process");

const context = {URL};
runInNewContext(readFileSync(join(__dirname, "rules.js"), "utf8"), context);
runInNewContext(readFileSync(join(__dirname, "cleaner.js"), "utf8"), context);
const cleaner = context.CleanURLs;
const shipped = context.CLEAN_URLS_RULES;
const basic = () => ({providers: {globalRules: {rules: ["utm_.*", "fbclid", "gclid"]}}});
const clean = (input, data = shipped) => cleaner.cleanURL(input, data).output;
const scoped = () => ({adguard: {siteRules: [{host: "example.com", patterns: ["^track=drop$"]}]}});
const conversionScript = "import json, build_copy_rules as b; a,_=b.parse_filter(b.ADGUARD_SOURCE.read_text()); u,_=b.parse_filter(b.UBLOCK_SOURCE.read_text()); print(json.dumps({'providers': json.loads(b.CLEAR_URLS_SOURCE.read_text())['providers'], 'adguard': b.merge_rule_sets(a,u)}))";
const converted = JSON.parse(execFileSync("python3", ["-B", "-c", conversionScript], {cwd: __dirname, encoding: "utf8"}));

const positives = [
    ["https://example.com/?fbclid=x", "https://example.com/"],
    ["https://example.com/?gclid=x&q=a%20b#frag", "https://example.com/?q=a%20b#frag"],
    ["https://example.com/?q=a+b&fbclid=x&q=c%2fd", "https://example.com/?q=a+b&q=c%2fd"],
    ["https://example.com/?%66bclid=x&bare&empty=&v=%7e", "https://example.com/?bare&empty=&v=%7e"],
    ["https://example.com/?fbclid=a&fbclid=b&keep=%2F", "https://example.com/?keep=%2F"],
    ["HTTPS://Example.COM:443/a%2fb?fbclid=x#A%2fB", "HTTPS://Example.COM:443/a%2fb#A%2fB"],
    ["https://www.youtube.com/watch?v=abc&list=xyz&index=2&t=5&fbclid=x", "https://www.youtube.com/watch?v=abc&list=xyz&index=2&t=5"],
    ["https://example.com/?keep=a%26b%3Dc&fbclid=x&&last", "https://example.com/?keep=a%26b%3Dc&&last"]
];
for (const [input, expected] of positives) {
    test(`shipped tracking: ${input}`, () => assert.equal(clean(input), expected));
}

for (const name of ["token", "access_token", "CODE", "state", "signature", "sig", "X-Amz-Date", "X-Amz-Signature", "X-Goog-Credential", "AWSAccessKeyId", "sessionid", "oauth_nonce", "api_key", "expires", "%74oken"]) {
    test(`signed/auth URL: ${name}`, () => {
        const input = `https://example.com/?fbclid=x&${name}=secret`;
        assert.equal(clean(input), input);
    });
}

test("unknown and functional names survive broad global and scoped rules", () => {
    const input = "https://example.com/?s=search&page=2&tag=topic&ref=section&source=app&unknown=yes&notfbclid=x&myutm_source=y&spm=part&campaign_id=object";
    const data = basic();
    data.providers.globalRules.rules = [".*"];
    data.referralMarketing = true;
    assert.equal(clean(input, data), input);
    assert.equal(clean(input), input);
});

test("global provider patterns match the whole parameter name", () => {
    const data = basic();
    data.providers.globalRules.rules = ["clid", "utm"];
    const input = "https://example.com/?fbclid=x&utm_source=y";
    assert.equal(clean(input, data), input);
});

test("value-specific duplicate removal preserves raw fields and order", () => {
    for (const query of ["track=keep&track=drop", "track=drop&track=keep"]) {
        const result = cleaner.cleanURL(`https://example.com/?${query}&x=%2f+%20&bare#frag%2f`, scoped());
        assert.equal(result.output, "https://example.com/?track=keep&x=%2f+%20&bare#frag%2f");
        assert.equal(JSON.stringify(result.removed), '["track"]');
    }
    assert.equal(clean("https://sub.example.com/?track=drop", scoped()), "https://sub.example.com/");
    assert.equal(clean("https://notexample.com/?track=drop", scoped()), "https://notexample.com/?track=drop");
});

test("filter regexes see name=value, not an unrelated matching value or partial name", () => {
    const data = scoped();
    data.adguard.siteRules[0].patterns = ["^track$"];
    assert.equal(clean("https://example.com/?track=keep", data), "https://example.com/?track=keep");
    data.adguard.siteRules[0].patterns = ["^track=drop$"];
    assert.equal(clean("https://example.com/?other=track%3Ddrop", data), "https://example.com/?other=track%3Ddrop");
});

test("exceptions veto all sources and all-value exceptions", () => {
    const data = basic();
    data.adguard = {globalLiterals: ["fbclid"], exceptions: [{urlPattern: "example\\.com", literals: ["fbclid"]}]};
    const input = "https://example.com/?fbclid=x";
    assert.equal(clean(input, data), input);
    assert.equal(clean("https://example.com/?FBCLID=x", data), "https://example.com/?FBCLID=x");
    data.adguard.exceptions = [{urlPattern: "example\\.com", all: true}];
    assert.equal(clean("https://example.com/?gclid=x", data), "https://example.com/?gclid=x");
    data.adguard.exceptions = [{urlPattern: "[", all: true}];
    assert.equal(clean(input, data), input);
});

test("initiator exceptions apply to any destination only for matching or unknown sources", () => {
    for (const destination of ["example.com", "hobbygames.ru", "other.test"]) {
        const input = `https://${destination}/?fbclid=abc123&utm_source=news`;
        for (const sourceURL of ["https://example.com/", "http://127.0.0.1:8080/", "https://nothobbygames.ru/", "https://hobbygames.ru.evil.test/"]) {
            assert.equal(clean(input, {...converted, sourceURL}), `https://${destination}/`);
        }
        for (const sourceURL of ["https://hobbygames.ru/", "https://shop.hobbygames.ru/", "https://HOBBYGAMES.RU./", undefined, null, "", "invalid", "about:blank", "https://", "https://u:p@example.com/", "https://example.com/\n"]) {
            assert.equal(clean(input, {...converted, sourceURL}), `https://${destination}/?utm_source=news`);
        }
        assert.equal(clean(input, converted), `https://${destination}/?utm_source=news`);
    }
});

test("negative initiator domains override positives and unsupported scopes retain exceptions", () => {
    const data = {...basic(), adguard: {globalLiterals: ["utm_source"], exceptions: [{
        urlPattern: ".*", literals: ["utm_source"],
        initiator: {include: ["hobbygames.ru"], exclude: ["private.hobbygames.ru"]}
    }]}};
    const input = "https://example.com/?utm_source=news";
    const rule = data.adguard.exceptions[0];
    for (const sourceURL of ["https://private.hobbygames.ru/", "https://sub.private.hobbygames.ru/", "https://example.com/"]) {
        assert.equal(clean(input, {...data, sourceURL}), "https://example.com/");
    }
    assert.equal(clean(input, {...data, sourceURL: "https://shop.hobbygames.ru/"}), input);
    rule.initiator.include = [];
    assert.equal(clean(input, {...data, sourceURL: "https://example.com/"}), input);
    assert.equal(clean(input, {...data, sourceURL: "https://private.hobbygames.ru/"}), "https://example.com/");
    assert.equal(clean(input, data), input);
    for (const initiator of [{include: ["google.*"], exclude: []}, {include: [], exclude: ["google.*"]},
        {include: ["hobbygames.ru"], exclude: [], unsupported: true}, {}, {include: "example.com", exclude: []}]) {
        rule.initiator = initiator;
        assert.equal(clean(input, {...data, sourceURL: "https://example.com/"}), input);
    }
});

test("target exception scope remains independent of known and unknown initiators", () => {
    const data = {...basic(), adguard: {exceptions: [{urlPattern: "^https://target\\.test/", literals: ["utm_source"],
        initiator: {include: ["hobbygames.ru"], exclude: []}}]}};
    for (const sourceURL of [undefined, "https://hobbygames.ru/"]) {
        assert.equal(clean("https://target.test/?utm_source=x", {...data, sourceURL}), "https://target.test/?utm_source=x");
        assert.equal(clean("https://example.com/?utm_source=x", {...data, sourceURL}), "https://example.com/");
    }
    delete data.adguard.exceptions[0].initiator;
    assert.equal(clean("https://target.test/?utm_source=x", {...data, sourceURL: "https://example.com/"}), "https://target.test/?utm_source=x");
});

test("MAIN and content copy pass the current source URL with freshly converted rules", async () => {
    const input = "https://example.com/?fbclid=abc123&utm_source=news";
    for (const file of ["navigation_main.js", "content_copy_cleaner.js"]) {
        const listeners = {};
        const writes = [];
        const parent = {closest: () => null};
        const text = {nodeType: 3, parentElement: parent};
        const context = {URL, setTimeout, clearTimeout, CLEAN_URLS_RULES: converted,
            location: {href: "https://example.com/"}, history: {replaceState() {}},
            navigator: {clipboard: {writeText(value) { writes.push(value); return Promise.resolve(); }}},
            document: {title: "Test", activeElement: null, addEventListener(type, listener) { listeners[type] = listener; }},
            getSelection: () => ({rangeCount: 1, isCollapsed: false, toString: () => input,
                getRangeAt: () => ({startContainer: text, endContainer: text})}),
            addEventListener(type, listener) { listeners[type] = listener; }, postMessage() {},
            chrome: {storage: {local: {get: () => Promise.resolve({enabled: true})}, onChanged: {addListener() {}}},
                runtime: {sendMessage: () => Promise.resolve()}}
        };
        context.window = context;
        runInNewContext(readFileSync(join(__dirname, "cleaner.js"), "utf8"), context);
        runInNewContext(readFileSync(join(__dirname, file), "utf8"), context);
        context.deliver = listeners.message;
        if (file === "navigation_main.js") {
            runInNewContext('deliver({source: window, data: {source: "clean-urls-copy", type: "settings", enabled: true}})', context);
        }
        await new Promise(resolve => setImmediate(resolve));
        for (const [sourceURL, expected] of [["https://example.com/", "https://example.com/"],
            ["https://hobbygames.ru/", "https://example.com/?utm_source=news"],
            ["http://127.0.0.1:8080/", "https://example.com/"],
            ["about:blank", "https://example.com/?utm_source=news"]]) {
            context.location.href = sourceURL;
            if (file === "navigation_main.js") {
                await context.navigator.clipboard.writeText(input);
            } else {
                const event = {target: parent, cancelable: true, defaultPrevented: false,
                    clipboardData: {types: [], setData(type, value) { assert.equal(type, "text/plain"); writes.push(value); }},
                    preventDefault() { this.defaultPrevented = true; }};
                listeners.copy(event);
                assert.equal(event.defaultPrevented, true);
            }
            assert.equal(writes.at(-1), expected, `${file}: ${sourceURL}`);
        }
    }
});

test("ClearURLs provider exceptions cannot be bypassed by global rules", () => {
    const data = basic();
    data.providers.site = {urlPattern: "example\\.com", exceptions: ["/keep"], rules: ["fbclid"]};
    const input = "https://example.com/keep?fbclid=x";
    assert.equal(clean(input, data), input);
    data.providers.globalRules.exceptions = ["example\\.com"];
    assert.equal(clean("https://example.com/?fbclid=x", data), "https://example.com/?fbclid=x");
});

test("referral toggling is scoped, protects functional and auth names", () => {
    const input = "https://www.amazon.com/dp/B123?tag=affiliate";
    for (const enabled of [false, true, false, true]) {
        assert.equal(clean(input, {...shipped, referralMarketing: enabled}), enabled ? "https://www.amazon.com/dp/B123" : input);
    }
    const data = basic();
    data.referralMarketing = true;
    data.providers.globalRules.referralMarketing = ["tag", "s", "page"];
    assert.equal(clean("https://example.com/?tag=t&s=x&page=2", data), "https://example.com/?tag=t&s=x&page=2");
    data.providers.site = {urlPattern: "example\\.com", referralMarketing: ["tag", "s", "page", "token"]};
    assert.equal(clean("https://example.com/?tag=t&s=x&page=2", data), "https://example.com/?s=x&page=2");
    assert.equal(clean("https://example.com/?tag=t&token=x", data), "https://example.com/?tag=t&token=x");
});

test("data replacement, mutation, enabled setting and default data are fresh", () => {
    const input = "https://example.com/?fbclid=x";
    const data = basic();
    assert.equal(clean(input, data), "https://example.com/");
    data.enabled = false;
    assert.equal(clean(input, data), input);
    data.enabled = true;
    data.providers.globalRules.rules = [];
    assert.equal(clean(input, data), input);
    assert.equal(clean(input, {}), input);
    context.CLEAN_URLS_RULES = {};
    assert.equal(cleaner.cleanURL(input).output, input);
    context.CLEAN_URLS_RULES = shipped;
    assert.equal(cleaner.cleanURL(input).output, "https://example.com/");
});

test("regex cache eviction and returned arrays do not affect later calls", () => {
    for (let index = 0; index < 600; index += 1) {
        const data = {adguard: {siteRules: [{host: "example.com", patterns: [`^track=${index}$`]}]}};
        assert.equal(clean(`https://example.com/?track=${index}`, data), "https://example.com/");
        assert.equal(clean(`https://example.com/?track=${index + 1}`, data), `https://example.com/?track=${index + 1}`);
    }
    const input = "https://example.com/?fbclid=x";
    const result = cleaner.cleanURL(input, basic());
    result.removed.push("fake");
    assert.equal(JSON.stringify(cleaner.cleanURL(input, basic()).removed), '["fbclid"]');
    cleaner.clearCache();
    assert.equal(clean(input, basic()), "https://example.com/");
});

test("invalid, credentialed, ambiguous and fragment-auth URLs are unchanged", () => {
    for (const input of ["text", "ftp://example.com/?fbclid=x", "https://u:p@example.com/?fbclid=x", "https://example.com/?q=%zz&fbclid=x", "https://example.com/?fbclid=x#access_token=x", "https://example.com/?fbclid=x\n", "https://example.com/?fbclid=x#code=secret"]) {
        assert.equal(clean(input), input);
    }
});

test("shipped converted artifacts preserve source exceptions", () => {
    assert.ok(shipped.adguard.exceptions?.length > 0, "Parent must rebuild rules.js with build_copy_rules.py");
    for (const input of ["https://urldefense.com/?fbclid=x", "https://web.archive.org/web/http://example.com/?gclid=x", "https://example.com/?utm_source=required", "https://metabase.com/?utm_term=required"]) {
        assert.equal(clean(input), input);
    }
});

test("fresh converter integrates with cleaner without writing artifacts", () => {
    const data = converted;
    assert.equal(clean("https://example.com/?fbclid=x&q=a%20b", data), "https://example.com/?q=a%20b");
    for (const input of ["https://urldefense.com/?fbclid=x", "https://example.com/?utm_source=required", "https://hobbygames.ru/?utm_medium=required", "https://other.test/?utm_medium=required", "https://example.com/?fbclid=x&token=t", "https://example.com/?s=term&page=2&unknown=y"]) {
        assert.equal(clean(input, data), input);
    }
});
