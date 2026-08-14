---
name: greasyfork
description: Manage userscripts on Greasy Fork (greasyfork.org) from a git repo - verify that pushed changes synced, publish/register new scripts, and configure sync-from-URL + webhooks. Use when publishing a userscript to Greasy Fork, checking whether a Greasy Fork script is up to date with its repo, wiring a repo so pushes auto-update Greasy Fork, or setting a script's visibility (public/unlisted/library). Greasy Fork has no write API - reads use its public JSON API, writes drive a local browser. Triggers - "publish to greasyfork", "is my greasyfork script in sync", "register a userscript", "set up greasyfork sync".
license: MIT. See LICENSE.txt
metadata:
  author: cyril.antoni
  version: "1.1"
---

# greasyfork

Publish and keep userscripts in sync on Greasy Fork from a git repo. Run the scripts below from the **root of a userscript repo** that contains a `greasyfork.json` manifest.

## Before publishing: test with a dev loader
New scripts are tested locally via a **dev loader** - a tiny Tampermonkey script that `@require`s the file from disk (see [DEVELOPMENT.md](../../docs/DEVELOPMENT.md)). **Whenever you create a new `scripts/*.user.js`, always produce its filled-in dev loader block** so it can be tested before publishing. The loaded file's header is ignored at runtime, so copy every `@match`, `@grant`, `@connect`, and external `@require` onto the loader (CDN `@require`s before the `file://` line).

## Placing UI on obfuscated sites
When a script injects UI into a site with hashed class names (Google, Slack, Notion), don't guess selectors. Get the target element's `outerHTML` from the user, or render the page headless with Puppeteer and screenshot, before committing placement. Anchor on stable attributes (`aria-label`, `name`, `role`, `data-qa`), never hashed classes, and position overlays `absolute`/`fixed` so they don't shift the page. Fuller checklist in the repo's CLAUDE.md; Slack specifics in [docs/slack-userscripts.md](../../docs/slack-userscripts.md).

## The model (read [references/greasyfork-model.md](references/greasyfork-model.md) before writing)
- **No write API.** Reads use the public JSON API (`api.greasyfork.org/en/scripts/<id>.json`). Writes (register, release/sync) are done by driving the real site in a local browser, because Cloudflare is bound to the user's IP - it must run on the user's machine.
- **`@version` must increase** on every change or Greasy Fork ignores the update (a no-op). The host repo's `pre-commit` hook handles this.
- **Sync model:** Greasy Fork *pulls* the raw GitHub URL. A per-user webhook (repo Settings -> Webhooks, URL from `greasyfork.org/en/users/webhook-info`) makes pushes near-immediate; otherwise periodic.
- **`@downloadURL`/`@updateURL` are stripped** by Greasy Fork - leave them out.

## Prerequisites
- A `greasyfork.json` in the cwd. Schema + examples: [references/manifest.md](references/manifest.md). Owner/repo/branch are derived from `git remote` - never hardcode them.
- Browser tools only: `ego-browser` (ego lite) on `PATH` - they drive it, they do not install or launch a browser of their own. Override the binary with `EGO_BROWSER_BIN`. No `npm install` is needed for these commands (the skill's `scripts/package.json` still installs Puppeteer, but only because `tools/make-icons.mjs`, `tools/shot-*.mjs` and the chrome-web-store skill's `frame-screenshot.mjs` borrow it from there).
- Browser tools log in once in ego-browser's window. The first write opens the Greasy Fork sign-in page in the `greasyfork release` task space; log in (any method) and it continues automatically. Task spaces share the browser's cookie jar, so the session outlives the space and every later run finds it. The login tab is never reloaded - detection is a same-origin `browserFetch` issued from it.

## Commands (run from the repo root)
| Task | Command | Auth |
|---|---|---|
| Check everything is in sync | `node skills/greasyfork/scripts/verify.mjs` | none |
| Update after a push (sync drifted + verify) | `node skills/greasyfork/scripts/release.mjs [--push]` | browser |
| Wire/re-point a script's sync URL | `node skills/greasyfork/scripts/release.mjs <id\|file\|all>` | browser |
| Publish a new script | `node skills/greasyfork/scripts/register.mjs <file.user.js>` | browser |
| List what's syncing | `node skills/greasyfork/scripts/status.mjs` | browser |

`verify` is the source of truth and works even if the browser tools break - prefer it for "did it sync?".

**The webhook is dead - always `release` after a push.** Greasy Fork's per-user webhook endpoint returns 403 to every POST (server-side at GF, not fixable from our config - full diagnosis in [references/greasyfork-model.md](references/greasyfork-model.md) and docs/PUBLISHING.md), so auto-pull on push never happens. `release.mjs` forces the pull GF should have done (waits for the raw CDN, syncs every script whose published version is behind, re-verifies).

## Recipes
- **Did my push land?** -> `verify.mjs`. `OK` = local == published == raw. `DRIFT` = run `release.mjs` (the webhook never auto-pulls). If still drifting: `@version` not bumped, or raw CDN lag ~5 min.
- **Publish a new script:** add an entry to `greasyfork.json` with `"id": null` and the desired `visibility` (`public`|`unlisted`|`library`) -> `register.mjs <file>` (creates the listing, pastes the code, writes the id back into the manifest) -> **commit the manifest and push** (the written-back id flips the README row from "not yet published" to the Greasy Fork link via the `gen-readme` pre-commit hook; the file must be pushed before the next step, since sync pulls the raw GitHub URL) -> `release.mjs <id>` (wires sync-from-URL + Automatic and pulls now, then verifies). New visibility usually matches its sibling scripts (the GitHub PR tools are `public`).
- **Wire / re-point an already-published script** (e.g. after moving or renaming its file): ensure its `greasyfork.json` entry has the real `id` and correct `file`, then `release.mjs <id>`.

## Cautions
- `register.mjs` creates a REAL listing. It refuses to run if the manifest entry already has an `id` (prevents duplicates). Confirm the new id afterward.
- The write tools DOM-scrape Greasy Fork's forms; they will break when Greasy Fork changes its markup. Selectors are centralized in the scripts. `verify.mjs` (public API) is the stable fallback.
- Browser work runs as source strings inside `ego-browser nodejs`, not as calls on a `Page` object, and that runtime is not a child process of the script - it gets no env, cwd or argv, and its output is buffered until it exits. Anything a step needs is serialized in as `INPUT`; anything the user must read *while* a step runs (the login prompt) is printed between steps. See the comments in `scripts/lib.mjs`.
