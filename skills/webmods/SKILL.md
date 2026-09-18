---
name: webmods
description: Scaffold a new Tampermonkey userscript and its dev loader, then build the feature. Generates scripts/<slug>.user.js with a filled metadata header, verifies the target-site favicon, registers it in greasyfork.json + the README table when those exist, and prints the dev-loader block to paste into Tampermonkey for live reload. Use when creating a new userscript / greasemonkey script, adding a feature to a website via Tampermonkey, or starting a *.user.js from scratch. Triggers - "new userscript", "create a tampermonkey script", "scaffold a userscript", "add a feature to <site> with tampermonkey".
license: MIT. See LICENSE.txt
metadata:
  author: cyril.antoni
  version: "1.0"
---

# webmods

Scaffold a new Tampermonkey userscript, then build the feature into it. Run the scaffolder from the **root of a userscript repo** (a repo of `scripts/*.user.js` files). Needs **Node 18+** (uses global `fetch`).

## 1. Scaffold the file

```
node skills/webmods/scripts/new-userscript.mjs \
  --name "Slack Quick Edit" \
  --match "https://app.slack.com/*" \
  --desc "Double-click your own Slack message to edit it"
```

- Required: `--name`, `--match`, `--desc`.
- Repeatable (pass again or comma-split): `--match`, `--grant`, `--connect`, `--require`.
- Optional: `--slug` (default: slugified name), `--dir` (default `scripts`), `--author` (default: `git config user.name`), `--icon` (override the favicon guess).

What it does:
- Writes `scripts/<slug>.user.js` with the metadata header in the conventional field order and a minimal IIFE body. Refuses to overwrite an existing file.
- **Favicon:** unless `--icon` is given, it guesses `https://<host>/favicon.ico` from the first `@match` and verifies it returns `200` + an `image/*` type. If it fails to verify, it warns - fix `@icon` by hand (never ship a script without a real, rendering icon).
- **If a `greasyfork.json` manifest exists:** appends `{ file, name, blurb }` and regenerates the README table via `tools/gen-readme.mjs`. Absent those files, it skips both steps - the `.user.js` and dev loader still work, so this runs in any repo.
- Prints the **dev-loader block** to paste into Tampermonkey.

## 2. Hand the dev loader to the user FIRST

**Give the user the filled-in dev-loader block the moment the file exists (right after scaffold) and again the moment the feature is written - BEFORE you run any of your own tests.** The user tests with live reload while you keep working; the sooner they have the loader, the sooner real feedback arrives. Their live test is the one that counts, and on auth-gated sites (Slack, Gmail, Notion, ...) it is the *only* test that can reach the logged-in DOM at all - your headless tools are logged out there. Never make the user ask for the loader.

The scaffolder prints a dev loader - a tiny Tampermonkey script that `@require`s the file from disk so edits live-reload. The **loaded file's own header is ignored at runtime**; the loader is what Tampermonkey reads. The scaffolder already copies every `@match`, `@grant`, `@connect`, and external `@require` onto the loader (CDN `@require`s before the `file://` line). It does **NOT** emit `@run-at` - if the feature needs one (e.g. `document-start`), add it to both the real file and the loader by hand. If you later change any `@match`/`@grant`/`@connect`/`@require`/`@run-at`, mirror it onto the loader or it won't take effect.

## 3. Build the feature, then re-deliver the loader

The scaffolded body is a stub (`// TODO`). Now write the actual feature. When it's written, re-post the dev loader (§2) so the user tests the real thing right away. Rules that save you:

- **Deliver before you self-test; your headless tests verify logic, not the live site.** Rendering the user's pasted/mock DOM in Puppeteer and injecting the script checks selectors, state, and toggling against a *static copy* - it does **not** prove placement, appearance, or native-CSS/runtime interaction on the real site, and must never be reported as if it did. It does not replace the user's dev-loader test. Hand off the loader first; run your own tests after, if at all, and label them as "logic against the pasted DOM", not "verified on <site>".

- **Placing UI on obfuscated sites (Google, Slack, Notion, ...):** don't guess hashed class names. Get the target element's `outerHTML` from the user, or render the page headless and inspect it, before deciding where to inject. Anchor on stable attributes (`aria-label`, `name`, `role`, `data-qa`), never hashed classes. Position injected UI `absolute`/`fixed` against the anchor's rect so it doesn't reflow the page.
- **Debugging on a logged-in site you can't see:** don't patch placement blind twice. Add a temporary `console.log` behind a `const DEBUG = true;` block in the real file, have the user reload and paste the output, then strip it before committing. In-file logs see the actual code path and runtime state (hover-only UI, hidden chars, which branch ran) that static HTML won't reveal.
- **Verify placement with a screenshot before committing** when the UI lands on a real site.
- **`@grant`:** if the feature needs `GM_setValue`/`GM_xmlhttpRequest`/etc., pass them at scaffold time (`--grant`) or add them to the header - and mirror them onto the dev loader, or the API is `undefined` at runtime.

## 4. Publish (optional)

If the repo uses Greasy Fork, hand off to the `greasyfork` skill to register and sync. This skill only scaffolds and builds; it does not publish.

## 5. Package as a Chrome extension (optional)

A userscript can also ship as a Chrome extension - one-click install, no Tampermonkey - for colleagues who won't set up a userscript manager. The **userscript stays the single source of truth**: never hand-copy the script into an extension. Add `extensions/<name>/` with a hand-written `manifest.json` and a `source.json` pointing at the `.user.js`, and `tools/build-extensions.mjs` (run by the pre-commit hook) generates the extension's code and syncs its manifest version. Use `world: "MAIN"` in the manifest if the script needs the page realm (page globals, or hooking the page's `fetch`/`XHR`). Full guide: **[docs/EXTENSIONS.md](../../docs/EXTENSIONS.md)**.

## Portability

Self-contained: the scaffolder and this SKILL.md carry everything needed. The `greasyfork.json`/README integration is auto-detected - present in the origin repo, skipped elsewhere. Copy the `skills/webmods/` directory into any userscript repo to use it there.
