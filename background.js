"use strict";

importScripts("rules.js", "cleaner.js", "special_urls.js", "special_resolver.js");

const DEFAULT_SETTINGS = {
    enabled: true,
    pasteClean: false,
    pasteCleanOptInVersion: 0,
    referralMarketing: false,
    copiedCount: 0,
    pasteCleanedCount: 0,
    lastRemoved: [],
    lastCleanedBefore: "",
    lastCleanedAfter: "",
    lastCleanedAt: 0,
    lastCleanedSource: ""
};

const PASTE_CLEAN_OPT_IN_VERSION = 1;
let settingsQueue = Promise.resolve();
let offscreenQueue = Promise.resolve();
let offscreenCreating = null;

function serializeSettings(operation) {
    const pending = settingsQueue.then(operation);
    settingsQueue = pending.catch(() => {});
    return pending;
}

async function readSettings() {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    if (settings.pasteCleanOptInVersion !== PASTE_CLEAN_OPT_IN_VERSION) {
        const patch = {pasteClean: false, pasteCleanOptInVersion: PASTE_CLEAN_OPT_IN_VERSION};
        await chrome.storage.local.set(patch);
        return {...settings, ...patch};
    }
    return settings;
}

function setSetting(key, value) {
    return serializeSettings(async () => {
        if (!["enabled", "pasteClean", "referralMarketing"].includes(key) || typeof value !== "boolean") {
            throw new Error("Invalid setting");
        }
        const settings = await readSettings();
        await chrome.storage.local.set({[key]: value});
        return {...settings, [key]: value};
    });
}

function cleanWithSettings(url, settings, force = false) {
    const data = {
        ...CLEAN_URLS_RULES,
        enabled: force ? true : settings.enabled,
        referralMarketing: settings.referralMarketing
    };
    return CleanURLs.cleanURL(url, data);
}

async function resolveSpecialURL(url, settings, force = false) {
    if (!force && !settings.enabled) {
        return {input: url, output: url, safe: false, changed: false, removed: []};
    }
    if (globalThis.CleanURLsSpecialResolver && CleanURLsSpecial.isThreadsShareURL(url)) {
        return CleanURLsSpecialResolver.resolveThreadsShare(url, {
            ...settings,
            force
        });
    }
    return cleanWithSettings(url, settings, force);
}

function getSettings() {
    return serializeSettings(readSettings);
}

async function updateBadge() {
    const settings = await getSettings();
    const total = Number(settings.copiedCount || 0) + Number(settings.pasteCleanedCount || 0);
    await chrome.action.setBadgeText({text: total ? String(total) : ""});
    await chrome.action.setBadgeBackgroundColor({color: settings.enabled ? "#18b7a0" : "#64748b"});
    await chrome.action.setTitle({
        title: total
            ? `LinkSweep — ${total} clean URL${total === 1 ? "" : "s"}`
            : "LinkSweep — Clean copied and opened URLs"
    });
}

async function createContextMenus() {
    await chrome.contextMenus.removeAll();
    await chrome.contextMenus.create({
        id: "clean-url-copy-link",
        title: "Copy clean link with LinkSweep",
        contexts: ["link"]
    });
    await chrome.contextMenus.create({
        id: "clean-url-copy-selection",
        title: "Copy clean URL from selection",
        contexts: ["selection"]
    });
}

async function copyToClipboard(tabId, text) {
    try {
        const results = await chrome.scripting.executeScript({
            target: {tabId},
            func: value => {
                const textarea = document.createElement("textarea");
                textarea.value = value;
                textarea.setAttribute("readonly", "");
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.documentElement.appendChild(textarea);
                textarea.select();
                const copied = document.execCommand("copy");
                textarea.remove();
                return copied;
            },
            args: [text]
        });
        return Boolean(results && results[0] && results[0].result);
    } catch (error) {
        return false;
    }
}

async function hasOffscreenDocument() {
    try {
        return Boolean(chrome.offscreen && await chrome.offscreen.hasDocument());
    } catch (error) {
        return false;
    }
}

async function ensureOffscreen() {
    if (!chrome.offscreen) return false;
    if (await hasOffscreenDocument()) return true;
    if (offscreenCreating) return offscreenCreating;

    offscreenCreating = chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["CLIPBOARD"],
        justification: "Read the clipboard only when passive URL cleaning is enabled, then replace tracking parameters when the result is verified safe."
    }).then(() => true).catch(() => false).finally(() => {
        offscreenCreating = null;
    });
    return offscreenCreating;
}

async function closeOffscreen() {
    if (!await hasOffscreenDocument()) return;
    try {
        await chrome.offscreen.closeDocument();
    } catch (error) {
        // The document may have closed between the existence check and close call.
    }
}

async function sendOffscreenSettings(settings) {
    try {
        await chrome.runtime.sendMessage({type: "offscreenConfigure", settings});
    } catch (error) {
        // The offscreen document may still be loading; offscreenReady retries this.
    }
}

function syncOffscreen() {
    const pending = offscreenQueue.then(async () => {
        let current = await getSettings();
        if (current.enabled && current.pasteClean) {
            if (!await ensureOffscreen()) return;
            current = await getSettings();
            await sendOffscreenSettings(current);
        }
        if (!current.enabled || !current.pasteClean) {
            await sendOffscreenSettings({...current, enabled: false});
            await closeOffscreen();
        }
    });
    offscreenQueue = pending.catch(() => {});
    return pending;
}

async function recordCleaning(result, source, counterKey) {
    const settings = await getSettings();
    const patch = {
        [counterKey]: Number(settings[counterKey] || 0) + 1,
        lastRemoved: Array.isArray(result.removed) ? result.removed : [],
        lastCleanedBefore: result.input || "",
        lastCleanedAfter: result.output || "",
        lastCleanedAt: Date.now(),
        lastCleanedSource: source
    };
    await chrome.storage.local.set(patch);
    await updateBadge();
    return patch;
}

chrome.runtime.onInstalled.addListener(async () => {
    await getSettings();
    await createContextMenus();
    await updateBadge();
    await syncOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
    await createContextMenus();
    await updateBadge();
    await syncOffscreen();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || typeof tab.id !== "number") return;
    const settings = await getSettings();

    let input = "";
    if (info.menuItemId === "clean-url-copy-link") input = info.linkUrl || "";
    if (info.menuItemId === "clean-url-copy-selection") input = info.selectionText || "";
    if (!CleanURLs.isURL(input)) return;

    // A deliberate context-menu action is manual cleaning, so it remains available
    // even when the automatic cleaning master switch is off.
    const result = await resolveSpecialURL(input, settings, true);
    const output = result.safe ? result.output : input;
    const copied = await copyToClipboard(tab.id, output);
    if (!copied) return;

    if (result.changed || result.resolved) {
        await recordCleaning({...result, input, output}, "context-menu", "copiedCount");
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "getSettings") {
        getSettings().then(sendResponse);
        return true;
    }

    if (message.type === "setSetting") {
        if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
        setSetting(message.key, message.value).then(sendResponse).catch(() => sendResponse({error: "Setting not saved"}));
        return true;
    }

    if (message.type === "cleanURL" || message.type === "resolveSpecialURL") {
        getSettings().then(settings => resolveSpecialURL(
            message.url,
            settings,
            Boolean(message.manual)
        ).then(sendResponse));
        return true;
    }

    if (message.type === "cleanClipboardURL") {
        getSettings().then(async settings => {
            const manual = message.manual === true;
            if (!manual && (!settings.enabled || !settings.pasteClean)) {
                return {input: message.url, output: message.url, safe: false, changed: false, removed: []};
            }
            return resolveSpecialURL(message.url, settings, manual);
        }).then(sendResponse);
        return true;
    }

    if (message.type === "copyCleaned") {
        getSettings().then(async settings => {
            const count = Number(settings.copiedCount || 0) + 1;
            const patch = {
                copiedCount: count,
                lastRemoved: Array.isArray(message.removed) ? message.removed : [],
                lastCleanedBefore: message.before || "",
                lastCleanedAfter: message.after || "",
                lastCleanedAt: Date.now(),
                lastCleanedSource: message.source || "copy"
            };
            await chrome.storage.local.set(patch);
            await updateBadge();
            sendResponse({ok: true, count});
        });
        return true;
    }

    if (message.type === "clipboardCleaned") {
        recordCleaning({
            input: message.before || "",
            output: message.after || "",
            removed: message.removed
        }, "clipboard", "pasteCleanedCount").then(patch => sendResponse({ok: true, ...patch}));
        return true;
    }

    if (message.type === "offscreenReady") {
        syncOffscreen().then(() => sendResponse({ok: true})).catch(() => sendResponse({ok: false}));
        return true;
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled || changes.pasteClean || changes.pasteCleanOptInVersion || changes.referralMarketing) {
        syncOffscreen().catch(() => {});
    }
    if (changes.enabled || changes.copiedCount || changes.pasteCleanedCount) {
        updateBadge().catch(() => {});
    }
});

createContextMenus().catch(() => {});
updateBadge().catch(() => {});
syncOffscreen().catch(() => {});
