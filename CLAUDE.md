# webmods - project instructions

## Always: dev loader block for new scripts

When you create a new userscript (`scripts/*.user.js`), ALWAYS output its **dev loader** block, filled in from the script's own metadata (no placeholders left), so the user can test it with live reload. This is required for testing - deliver it as part of any new script, without being asked.

```javascript
// ==UserScript==
// @name         DEV: <Script Name> (local)
// @namespace    http://tampermonkey.net/
// @icon         <target site favicon, copied from the script>
// @version      0.0.1
// @description  dev loader
// @match        <every @match from the script>
// @grant        <every @grant from the script, incl. GM_* and `none`>
// @connect      <every @connect from the script, if any>
// @require      <each external/CDN @require, in order, BEFORE the file line>
// @require      file:///ABSOLUTE/PATH/scripts/<script>.user.js
// ==/UserScript==
```

The loaded file's own header is IGNORED at runtime - the loader is what Tampermonkey reads. So:
- Copy every `@match`, `@grant` (including `GM_*` and `none`), and `@connect` onto the loader.
- Put external `@require` (CDN libs) BEFORE the `@require file://` line, in dependency order.
- Use the absolute on-disk path for the `file://` require.

Full guide and gotchas: [DEVELOPMENT.md](docs/DEVELOPMENT.md). Publishing: [PUBLISHING.md](docs/PUBLISHING.md) + the `greasyfork` skill.

**Pushing does NOT update Greasy Fork.** The auto-pull webhook is dead server-side (endpoint 403s every POST, diagnosed 2026-06-15, full details in PUBLISHING.md - do not re-debug it). After every push, run `node skills/greasyfork/scripts/release.mjs` to force the pull, and confirm with `node skills/greasyfork/scripts/verify.mjs` (local = published = raw). Never tell the user a push alone released anything.

The user runs EVERY script through its local-file dev loader (live reload). So to debug a bug on a logged-in site, add temporary `console.log`s directly into the real `.user.js` (behind a `const DEBUG = true;` block), have the user reload the tab and paste the output, then strip the block before committing. Do NOT hand over a standalone console snippet - the file is already live-reloading, and in-file logs see the actual code path (which branch ran, real internal state). See [DEVELOPMENT.md](docs/DEVELOPMENT.md#debugging-on-a-logged-in-site).

## New scripts: target-site `@icon`

Every script (and its dev loader) carries an `@icon` of the target site's favicon, so it's identifiable in the Tampermonkey dashboard. Put it right after `@namespace`. Always fetch a real icon for a new script - never ship without one, never guess the URL.

How to get the right URL:
1. Prefer the site's own stable favicon: `https://<target-host>/favicon.ico` (e.g. `https://app.slack.com/favicon.ico`, `https://meet.google.com/favicon.ico`).
2. Verify before committing - `curl -s -o /dev/null -w "%{http_code} %{content_type}" -L <url>` must return `200` and an `image/*` type.
3. No `/favicon.ico`? Read the site's `<link rel="icon">`: `curl -sL <site> | grep -i 'rel="[^"]*icon'` - but skip version-hashed asset paths (e.g. `a.slack-edge.com/e6a93c1/...`), they rot.
4. Avoid Google's `s2/favicons` proxy - Tampermonkey often won't render it in the dashboard. Last resort: an inline `data:` URI of the logo (always renders, no network).

## Placing UI on obfuscated DOM (Google, Slack, Notion, ...)

Sites with hashed/minified class names (e.g. Google's `lnXdpd`) will burn you if you guess selectors. Before writing or adjusting where a script injects UI:

1. **Get the real element first** - ask the user for the target's `outerHTML`, or render the page headless and inspect it (Puppeteer is installed under `skills/greasyfork/scripts/node_modules`: load the URL, inject the library + script via `page.evaluate` to bypass page CSP, then screenshot).
2. **Anchor on stable attributes** - `aria-label`, `name`, `role`, `data-qa` - never hashed classes.
3. **Overlay without reflow** - position the injected element `absolute`/`fixed` against the anchor's rect; in-flow insertion shifts the page (it pushed Google's logo down).
4. **Verify with a screenshot before committing** - don't ship placement you haven't seen.
5. **For behavior bugs, instrument - don't re-guess** - static `outerHTML` won't reveal runtime state (hover-only UI, hidden chars like `\uFEFF`, which code path actually ran). On an auth-gated site you can't see, when a fix fails, add a temporary `console.log` and have the user paste it rather than patching blind a second time. See [Debugging on a logged-in site](docs/DEVELOPMENT.md#debugging-on-a-logged-in-site).

## Companion Chrome extensions: edit the userscript, not the generated copy

Some userscripts are also shipped as Chrome extensions (under `extensions/<name>/`) so colleagues can install them without Tampermonkey. Rules for developing in this setup:

- **The `.user.js` is the single source of truth.** The extension's content-script `.js` is GENERATED from it by `tools/build-extensions.mjs` and carries a `// GENERATED ... do not edit` banner. Never hand-edit that file - edit `scripts/<name>.user.js`.
- Each generated extension has a `extensions/<name>/source.json` naming its source userscript. The hand-written `manifest.json` holds extension-only metadata; its `version` is auto-synced to the userscript `@version` by the generator.
- The **pre-commit hook regenerates and re-stages** the extension on any `.user.js` / `source.json` change (the same pattern as `gen-readme` for the README). Don't bypass it, and don't commit hand-edits to a generated `.js`.
- Extensions with **no `source.json`** (e.g. `csp-unlock`) are hand-authored - the generator leaves them alone.
- In the manifest, use `world: "MAIN"` when the script needs the page realm (page globals, or hooking the page's `fetch`/`XHR`); the default isolated world otherwise. `world: "MAIN"` needs `minimum_chrome_version: "111"`.

- **Verify an extension headlessly before handing it over.** Puppeteer (already under `skills/greasyfork/scripts/node_modules`) can `--load-extension` a real extension dir, drive its service worker, and hit real local services. The extension-only failure modes - MV3 CORS, the service worker, `chrome.storage`, request headers - are precisely what the Tampermonkey dev loop never exercises, so "it works as a userscript" is not evidence. Patterns and gotchas: [docs/EXTENSION-TESTING.md](docs/EXTENSION-TESTING.md).

Full guide (how to add one, `@grant`->shim mapping, distribution channels): [docs/EXTENSIONS.md](docs/EXTENSIONS.md).
