#!/usr/bin/env node
// Generate companion Chrome-extension bundles from their source userscript, so the userscript
// stays the single source of truth. Each extensions/<name>/source.json names its source
// .user.js; this copies that file into the extension (with a generated banner), prepends a
// shim for each GM_* @grant it declares, and syncs the extension manifest's `version` to the
// userscript's @version. Hand-authored extensions (no source.json, e.g. csp-unlock) are left
// untouched.
//
// Prints each written path (one per line) so the pre-commit hook can `git add` them.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXT_DIR = join(ROOT, 'extensions');
const written = [];

// Chrome manifest versions are 1-4 dot-separated integers with no leading zeros.
const normalizeVersion = (v) => v.split('.').map((p) => String(parseInt(p, 10) || 0)).join('.');
const userscriptVersion = (src) => {
    const m = src.match(/^\/\/\s*@version\s+(.+)$/m);
    return m ? m[1].trim() : null;
};
const userscriptGrants = (src) => [...src.matchAll(/^\/\/\s*@grant\s+(\S+)/gm)]
    .map((m) => m[1])
    .filter((g) => g !== 'none');

// A GM_* API the extension build can stand in for. `code` runs in the content script's
// isolated world, above the copied userscript body. Anything not listed here has no shim,
// and the build refuses rather than emit an extension that silently does nothing.
const SHIMS = {
    GM_xmlhttpRequest: {
        // Relayed to the service worker: MV3 content scripts get no cross-origin
        // privileges, so a direct fetch here would be a CORS request from the page's origin.
        // Supports only the subset the repo's scripts use - onload/onerror/ontimeout and
        // status/responseText. No onprogress, no abort(), no responseType, no binary.
        needsBridge: true,
        code: `function GM_xmlhttpRequest(opts) {
    chrome.runtime.sendMessage(
        { __gm: 'xhr', method: opts.method || 'GET', url: opts.url,
          headers: opts.headers || {}, data: opts.data, timeout: opts.timeout },
        (res) => {
            if (chrome.runtime.lastError) return opts.onerror?.({ error: chrome.runtime.lastError.message });
            if (res.timeout) return opts.ontimeout?.();
            if (res.error) return opts.onerror?.(res);
            opts.onload?.({ status: res.status, responseText: res.responseText });
        }
    );
}`
    },
    // chrome.storage is async, so these return Promises where Tampermonkey returns the
    // value directly. A script using them must await GM_getValue to work in both.
    GM_getValue: { code: `function GM_getValue(key, def) { return chrome.storage.local.get(key).then((o) => o[key] ?? def); }` },
    GM_setValue: { code: `function GM_setValue(key, value) { return chrome.storage.local.set({ [key]: value }); }` },
    GM_deleteValue: { code: `function GM_deleteValue(key) { return chrome.storage.local.remove(key); }` }
};

const BRIDGE = `chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.__gm !== 'xhr') return;
    const ctl = new AbortController();
    const timer = msg.timeout ? setTimeout(() => ctl.abort(), msg.timeout) : null;
    fetch(msg.url, { method: msg.method, headers: msg.headers, body: msg.data, signal: ctl.signal })
        .then(async (r) => sendResponse({ status: r.status, responseText: await r.text() }))
        .catch(() => sendResponse(ctl.signal.aborted ? { timeout: true } : { error: 'network' }))
        .finally(() => timer && clearTimeout(timer));
    return true;
});
`;

if (!existsSync(EXT_DIR)) process.exit(0);

for (const name of readdirSync(EXT_DIR)) {
    const dir = join(EXT_DIR, name);
    const cfgPath = join(dir, 'source.json');
    if (!existsSync(cfgPath)) continue; // hand-authored extension, skip

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const srcPath = join(ROOT, cfg.userscript);
    if (!existsSync(srcPath)) {
        console.error(`build-extensions: source not found: ${cfg.userscript} (for ${name})`);
        process.exit(1);
    }
    const src = readFileSync(srcPath, 'utf8');

    // 1) the content-script body = a copy of the userscript, with a generated banner and
    //    a shim for every GM_* the userscript grants
    const grants = userscriptGrants(src);
    const unshimmed = grants.filter((g) => !SHIMS[g]);
    if (unshimmed.length) {
        console.error(`build-extensions: no shim for ${unshimmed.join(', ')} (in ${cfg.userscript}).`);
        console.error('Add one to SHIMS in this file, or the extension will silently do nothing.');
        process.exit(1);
    }
    const prelude = grants.length
        ? `\n// GM shims for @grant ${grants.join(', ')} - these replace Tampermonkey's APIs.\n`
            + grants.map((g) => SHIMS[g].code).join('\n') + '\n'
        : '';

    const out = cfg.out || `${name}.js`;
    const outPath = join(dir, out);
    const body = `// GENERATED from ${cfg.userscript} by tools/build-extensions.mjs - do not edit.\n`
        + `// Edit the source userscript instead; this file is regenerated on commit.\n`
        + prelude
        + src;
    if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== body) {
        writeFileSync(outPath, body);
        written.push(join('extensions', name, out));
    }

    // 2) the service worker that GM_xmlhttpRequest relays through, generated alongside the
    //    shim so the message contract cannot drift out of step
    if (grants.some((g) => SHIMS[g].needsBridge)) {
        const bridgePath = join(dir, 'gm-bridge.js');
        const bridge = `// GENERATED by tools/build-extensions.mjs - do not edit.\n`
            + `// Service-worker half of the GM_xmlhttpRequest shim in ${out}.\n`
            + BRIDGE;
        if (!existsSync(bridgePath) || readFileSync(bridgePath, 'utf8') !== bridge) {
            writeFileSync(bridgePath, bridge);
            written.push(join('extensions', name, 'gm-bridge.js'));
        }
    }

    // 3) keep the manifest version in step with the userscript @version
    const manPath = join(dir, 'manifest.json');
    const uv = userscriptVersion(src);
    if (existsSync(manPath) && uv) {
        const man = JSON.parse(readFileSync(manPath, 'utf8'));
        const nv = normalizeVersion(uv);
        if (man.version !== nv) {
            man.version = nv;
            writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
            written.push(join('extensions', name, 'manifest.json'));
        }
    }
}

if (written.length) console.log(written.join('\n'));
