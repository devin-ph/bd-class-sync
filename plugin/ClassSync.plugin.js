/**
 * @name ClassSync
 * @author devin
 * @version 1.1.0
 * @description Records Discord's CSS class names for every client build, so bd-class-remap can carry your themes across Discord's class renames. Shows a notice when a theme was remapped.
 */

/*
 * What it writes (nothing else is touched):
 *   <BetterDiscord>/data/class-sync/builds/<build>.json  {build, firstSeen, lastSeen, modules: {hash: [classes]}}
 *   <BetterDiscord>/data/class-sync/latest.json          {build, updated, modules, classes}
 * latest.json is rewritten only when the build changes or new modules are found, so a watcher on it
 * (the bd-class-remap.path unit) runs rarely.
 *
 * Three sources, merged by hash (a CSS module's classes share it):
 *   - webpack factories whose whole body is `module.exports = {k: "name_hash", ...}`: the shape of a CSS
 *     module (rspack minifies the keys, so only the values are trusted; all must share one hash).
 *     Loaded-but-unexecuted factories count, so a page not opened yet can still be known.
 *   - executed modules (BdApi.Webpack) with that same all-classes-one-hash export.
 *   - Discord's own stylesheets (/assets/*.css; never BetterDiscord's or a theme's, whose selectors
 *     may hold stale classes).
 * Composed classes ("a_x b_y") keep their first class.
 */

const fs = require("fs");
const path = require("path");

const HASHED = /^([A-Za-z][\w-]*?)_{1,2}([\w-]{5,6})$/;
// A factory that only exports an object literal: `id(e){e.exports={...}}`.
const EXPORTS_ONLY = /^[^{]*\{\s*(?:"use strict";\s*)?[\w$]+\.exports\s*=\s*\{([^{}]*)\}\s*;?\s*\}$/;
const ENTRY = /(?:[\w$]+|"[^"]*"|'[^']*')\s*:\s*"([^"]*)"/g;
const SELECTOR_CLASS = /\.([A-Za-z][\w-]*)(?![\w-])/g;
const FIRST_SCAN_MS = 15000;
const RESCAN_MS = 10 * 60 * 1000;

module.exports = class ClassSync {
    constructor(meta) { this.meta = meta; this.timers = []; }

    start() {
        this.dir = path.join(BdApi.Plugins.folder, "..", "data", "class-sync");
        this.timers.push(setTimeout(() => this.run(), FIRST_SCAN_MS));
        this.timers.push(setInterval(() => this.run(), RESCAN_MS));
    }

    stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }

    run() {
        try { this.record(); } catch (e) { BdApi.Logger.error(this.meta.name, "Recording classes failed", e); }
        try { this.announce(); } catch (e) { BdApi.Logger.error(this.meta.name, "Reading the remap report failed", e); }
    }

    // webpack's require, through the usual chunk-push handshake.
    webpackRequire() {
        const key = Object.keys(window).find(k => k.startsWith("webpackChunk"));
        if (!key) return null;
        let req = null;
        window[key].push([[Symbol(this.meta.name)], {}, r => { req = r; }]);
        window[key].pop();
        return req;
    }

    // The client build: the hash in the main bundle's file name (web.<hash>.js).
    buildId() {
        for (const s of document.querySelectorAll("script[src]")) {
            const m = s.src.match(/\/assets\/web\.([\w]+)\.js/);
            if (m) return m[1];
        }
        return null;
    }

    collect() {
        const modules = {};
        const add = cls => {
            const m = cls.match(HASHED);
            if (m) (modules[m[2]] ??= new Set()).add(cls);
        };
        // A class map: every value a hashed class, all with one hash.
        const classMap = values => {
            if (!values.length) return false;
            const firsts = values.map(v => typeof v === "string" ? v.split(" ")[0] : "");
            const parsed = firsts.map(c => c.match(HASHED));
            if (parsed.some(p => !p) || new Set(parsed.map(p => p[2])).size !== 1) return false;
            firsts.forEach(add);
            return true;
        };
        const req = this.webpackRequire();
        for (const factory of Object.values(req?.m || {})) {
            let src;
            try { src = Function.prototype.toString.call(factory); } catch { continue; }
            if (src.length > 100000) continue;
            const body = src.match(EXPORTS_ONLY);
            if (!body) continue;
            const values = [...body[1].matchAll(ENTRY)].map(e => e[1]);
            if (values.length === (body[1].match(/:/g) || []).length) classMap(values);
        }
        const isMap = m => m && typeof m === "object" && !Array.isArray(m)
            && Object.values(m).length > 0 && Object.values(m).every(v => typeof v === "string");
        for (const m of BdApi.Webpack.getModules(isMap, {searchExports: false})) classMap(Object.values(m));
        for (const sheet of document.styleSheets) {
            if (!sheet.href || !/\/assets\/[^/]+\.css(\?|$)/.test(sheet.href)) continue;
            let rules;
            try { rules = sheet.cssRules; } catch { continue; }
            const walk = list => {
                for (const r of list) {
                    if (r.cssRules) walk(r.cssRules);
                    if (r.selectorText) for (const m of r.selectorText.matchAll(SELECTOR_CLASS)) add(m[1]);
                }
            };
            walk(rules);
        }
        return modules;
    }

    readJson(file, fallback) {
        try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
    }

    writeJson(file, data) {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
    }

    record() {
        const build = this.buildId();
        if (!build) { BdApi.Logger.warn(this.meta.name, "No client build found; nothing recorded"); return; }
        const found = this.collect();
        const file = path.join(this.dir, "builds", build + ".json");
        const now = new Date().toISOString();
        const stored = this.readJson(file, {build, firstSeen: now, modules: {}});
        let added = 0;
        for (const [hash, set] of Object.entries(found)) {
            const known = new Set(stored.modules[hash] || []);
            for (const cls of set) if (!known.has(cls)) { known.add(cls); added++; }
            stored.modules[hash] = [...known].sort();
        }
        const latestFile = path.join(this.dir, "latest.json");
        const latest = this.readJson(latestFile, {});
        stored.lastSeen = now;
        this.writeJson(file, stored);
        if (added === 0 && latest.build === build) return;
        const classes = Object.values(stored.modules).reduce((n, list) => n + list.length, 0);
        this.writeJson(latestFile, {build, updated: now, modules: Object.keys(stored.modules).length, classes});
        BdApi.Logger.info(this.meta.name, `Build ${build}: ${added} new classes, ${classes} known`);
    }

    // bd-class-remap leaves report.json behind; tell the user once per report.
    announce() {
        const report = this.readJson(path.join(this.dir, "report.json"), null);
        if (!report || !report.time || BdApi.Data.load(this.meta.name, "lastReport") === report.time) return;
        BdApi.Data.save(this.meta.name, "lastReport", report.time);
        const mapped = Object.keys(report.mapped || {}).length, pending = (report.pending || []).length;
        if (!mapped) return;
        const text = `ClassSync: Discord renamed its CSS classes; ${mapped} were updated in your themes.`
            + (pending ? ` ${pending} are not matched yet (retried as more of Discord loads).` : "");
        BdApi.UI.showNotice(text, {type: "info", timeout: 15000});
    }
};
