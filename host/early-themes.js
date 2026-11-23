/*
 * early-themes: paint BetterDiscord's enabled themes from Discord's first frame.
 *
 * BetterDiscord applies themes last: it waits until Discord has connected to its gateway, then starts
 * every plugin, and only then injects the themes. Until that point, a few seconds at every start,
 * the client shows Discord's default look. This module runs in Discord's main process (the host stub
 * that bd-reinject writes loads it before the client). When the main window's page is parsed, it
 * puts a copy of each enabled theme into the page, and the page removes each copy as soon as
 * BetterDiscord injects that theme itself. From then on BetterDiscord alone owns the themes, so live
 * reloads and turning a theme off work as before.
 *
 * It reads the same files BetterDiscord does (themes/*.theme.css and data/<channel>/themes.json) and
 * never throws into Discord: any failure leaves the start exactly as it was without this module.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const EXTENSION = ".theme.css";
const CLIENT_HOST = /^(?:ptb\.|canary\.)?discord\.com$/;

function bdFolder() {
    if (process.env.BETTERDISCORD_DATA_PATH) return process.env.BETTERDISCORD_DATA_PATH;
    const config = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");
    return path.join(config, "BetterDiscord");
}

// BetterDiscord keeps one data folder per release channel, named in the host's build_info.json.
function releaseChannel(appPath) {
    try {
        const info = JSON.parse(fs.readFileSync(path.resolve(appPath, "..", "build_info.json"), "utf8"));
        return info.releaseChannel || "stable";
    } catch {
        return "stable";
    }
}

// The @name of the leading /** */ block: BetterDiscord's id for an addon (the file name without one).
function themeName(css) {
    const block = css.match(/^﻿?\s*\/\*\*([\s\S]*?)\*\//);
    const name = block && block[1].match(/@name[ \t]+([^\r\n]+)/);
    return name ? name[1].trim() : null;
}

// The enabled themes, each with the id of the <style> BetterDiscord will put it in.
function enabledThemes(root, channel) {
    let enabled;
    try {
        enabled = JSON.parse(fs.readFileSync(path.join(root, "data", channel, "themes.json"), "utf8"));
    } catch {
        return [];
    }
    const dir = path.join(root, "themes");
    let files;
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith(EXTENSION)).sort();
    } catch {
        return [];
    }
    const themes = [];
    for (const file of files) {
        let css;
        try { css = fs.readFileSync(path.join(dir, file), "utf8"); } catch { continue; }
        const name = themeName(css) || file;
        if (enabled[name] !== true) continue;
        // BetterDiscord's slug and container id, from ThemeManager and DOMManager.injectTheme.
        const slug = file.replace(EXTENSION, "").replace(/ /g, "-");
        themes.push({name, container: slug + "-theme-container", css});
    }
    return themes;
}

// The page side. BetterDiscord puts themes in <bd-themes>, inside <bd-head> at the end of <body>,
// so they come after all of Discord's stylesheets; a copy at the same place (or at the end of
// <body> while BetterDiscord has not created its elements yet) cascades the same way.
function pageScript(themes) {
    return `(() => {
    const themes = ${JSON.stringify(themes)};
    for (const {name, container, css} of themes) {
        const id = CSS.escape(container);
        if (document.getElementById(id)) continue;
        const style = document.createElement("style");
        style.id = "early-" + container;
        style.textContent = css;
        (document.querySelector("bd-themes") || document.body || document.documentElement).append(style);
        const shown = Math.round(performance.now());
        const timer = setInterval(() => {
            if (!document.getElementById(id)) return;
            clearInterval(timer);
            style.remove();
            console.log("%c[early-themes]%c " + name + ": shown at " + shown + " ms, BetterDiscord took over at "
                + Math.round(performance.now()) + " ms", "color: #3E82E5; font-weight: 700;", "");
        }, 250);
    }
})();`;
}

function isClient(url) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && CLIENT_HOST.test(u.hostname) && !u.pathname.startsWith("/popout");
    } catch {
        return false;
    }
}

function install() {
    const {app} = require("electron");
    app.on("web-contents-created", (_, contents) => {
        if (contents.getType() !== "window") return;
        contents.on("dom-ready", () => {
            try {
                if (!isClient(contents.getURL())) return;
                // Resolved here, not at load: BetterDiscord may set its data path after this loads.
                const themes = enabledThemes(bdFolder(), releaseChannel(app.getAppPath()));
                if (themes.length) contents.executeJavaScript(pageScript(themes)).catch(() => {});
            } catch (error) {
                console.error("[early-themes]", error);
            }
        });
    });
}

if (process.versions.electron && process.type === "browser") {
    try { install(); } catch (error) { console.error("[early-themes]", error); }
}

module.exports = {enabledThemes, isClient, pageScript, releaseChannel, themeName};
