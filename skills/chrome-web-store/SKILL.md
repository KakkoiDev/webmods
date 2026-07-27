---
name: chrome-web-store
description: Publish and update a companion Chrome extension on the Chrome Web Store from this repo. Packages the upload zip and auto-pads screenshots; the first publish (account, listing, screenshots) is done once in the Developer Dashboard; version UPDATES are then automated via the Chrome Web Store API. Use when publishing a generated extension (extensions/<name>) to the Chrome Web Store, packaging its zip, sizing its screenshots, pushing a new version, or wiring the API credentials. Triggers - "publish to chrome web store", "package the extension", "update the extension on the web store", "cws publish", "release the chrome extension", "chrome web store".
license: MIT. See LICENSE.txt
metadata:
  author: cyril.antoni
  version: "1.0"
---

# chrome-web-store

Publish and keep a companion Chrome extension updated on the Chrome Web Store. Extensions here are generated from userscripts (see [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md)); this skill ships them. Detailed human walkthrough + paste-ready listing copy: [docs/CHROME-WEB-STORE.md](../../docs/CHROME-WEB-STORE.md).

## The model (read first)

- **The first publish is dashboard-only.** The Chrome Web Store API can upload a package and publish it, but it **cannot** create the listing or set the store metadata a first submission requires - description, screenshots, category, privacy policy. So the very first release of an item is done by hand in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), which also mints the item's **ID**.
- **Version updates are API-automatable.** Once the item exists and its listing is filled, `scripts/cws-publish.mjs` uploads a new zip to that item and publishes it, no dashboard. Listing changes (new screenshots, new copy) still go through the dashboard.
- **The version must increase every update.** The repo's pre-commit hook bumps the extension manifest `version` from the userscript `@version`, so a committed change is enough.

## The pieces

Per extension, in `extensions/<name>/`:
- `manifest.json` - hand-written MV3 manifest (world/matches/run_at/permissions/icons); its `version` auto-syncs from the userscript.
- `source.json` - names the source userscript. `tools/build-extensions.mjs` (pre-commit hook) regenerates the content-script `.js` from it - **never hand-edit the generated `.js`.**
- `icon.svg` + `icons/icon-*.png` - full-bleed toolbar icons (`tools/make-icons.mjs`).
- `icon-store.svg` + `store-icon-128.png` - the padded 128px **Store** icon for the dashboard (distinct from the toolbar icons).
- `PRIVACY.md` - privacy policy; host its GitHub URL.
- `store-listing.md` - all listing copy (summary, description, single-purpose, permission justification, category, language, visibility) **plus the item ID**. The paste source for the dashboard.
- a 1280x800 (or 640x400) screenshot.

Skill scripts, in `skills/chrome-web-store/scripts/`:
- `make-zip.mjs` - package the upload zip (runtime files derived from the manifest).
- `pad-screenshot.mjs` - resize/letterbox a screenshot to a valid size.
- `frame-screenshot.mjs` - compose a captured PNG (or a before/after pair) onto a branded canvas at native scale, for captures too small to pad without blurring.
- `get-refresh-token.mjs` - one-off OAuth loopback flow to mint the API refresh token.
- `keyring.mjs` + `cws-keychain.mjs` - store the API creds in the OS keyring (macOS Keychain / Linux libsecret).
- `cws-publish.mjs` - upload a new zip to the item and publish (API version-updates only; resolves each cred from env then the keyring).

End-to-end flow: build/debug the userscript -> the hook generates the extension -> `make-zip` -> **first publish is manual in the dashboard** (fills the listing, mints the item ID) -> store the creds once (`cws-keychain store`) -> every later version publishes headless with `cws-publish` (secrets from the keyring; the public item ID from `--id` or `store-listing.md`).

## Prerequisites

- A registered CWS developer account (one-time US$5). If Google Payments errors on desktop (`OR_*`), retry with browser extensions off / in incognito, or on a phone.
- The extension prepped - icons, manifest, privacy policy. See [docs/CHROME-WEB-STORE.md](../../docs/CHROME-WEB-STORE.md) (icons come from `tools/make-icons.mjs`). The dashboard **Store icon** must be 128x128 with the art at ~96x96 centered + transparent padding (no edge bleed) - a separate, padded PNG from the full-bleed manifest/toolbar icons.
- For API updates only: OAuth credentials (Step 4) + a one-time `npm install` in this skill's `scripts/`.

## Step 1 - package the upload zip

```sh
node skills/chrome-web-store/scripts/make-zip.mjs extensions/<name>
```

Derives the runtime files from the manifest (manifest.json + the JS/CSS/icons/rules it references) and zips them, excluding `source.json`, `README`, `icon.svg`, screenshots, `.gitignore`, and `_metadata`. Writes `extensions/<name>-cws.zip` (gitignored). Override with `--out=<path>`. It prints the archive contents - confirm no dev files slipped in.

## Step 2 - size the screenshots (auto-pad + warn)

CWS screenshots must be **exactly 1280x800 or 640x400**. Auto-pad an off-size shot:

```sh
node skills/chrome-web-store/scripts/pad-screenshot.mjs shot.png            # -> shot-1280x800.png
node skills/chrome-web-store/scripts/pad-screenshot.mjs shot.png --size=640x400 --bg=252525
```

macOS (uses `sips`). It letterboxes on `--bg` and prints a **WARNING** when the source was not the target ratio (you'll get bars top/bottom or left/right). For a full-bleed image, capture at the target size directly. You still upload screenshots by hand in the dashboard - the API can't.

**When the capture is much smaller than 1280x800**, padding means a 2-3x upscale and visible softness on the first thing anyone sees. Compose instead - the UI stays at native scale on a branded canvas, with a caption doing the work of filling the frame:

```sh
node skills/chrome-web-store/scripts/frame-screenshot.mjs out.png \
  --shot=before.png --shot=after.png --scale=1.15 --caption="Translate your draft before you send it"
```

Two `--shot`s sit side by side, which is how a before/after pair fits one screenshot. `--scale` multiplies the source's natural size (keep it at or below ~1.2 to stay crisp), `--bg` sets the gradient base, `--size` defaults to 1280x800. Uses the same borrowed Puppeteer as `tools/make-icons.mjs`, so run it from the repo root. Worked example: `extensions/slack-ai-translate/store-screenshot-*.png`.

## Driving the dashboard in a browser (for what the API can't do)

`dashboard.mjs` automates the dashboard-only parts: creating the item, the listing copy, screenshots, the privacy answers, and visibility. It reads everything from the extension's own `store-listing.md`, so the repo stays the source of truth and nothing per-extension is baked into the script.

**Sign in first, by hand, in a normal Chrome.** Google refuses its sign-in flow inside a Puppeteer-launched browser (*"This browser or app may not be secure"*) and no flag or user-agent tweak reliably beats it. The script only ever attaches to a session you authenticated yourself:

```sh
# 1. you launch a real Chrome and sign in by hand in this window
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/chrome-web-store/chrome-profile" \
  --no-first-run --no-default-browser-check \
  "https://chrome.google.com/webstore/devconsole" &

# 2. everything else is the script
node skills/chrome-web-store/scripts/dashboard.mjs all extensions/<name>   # create + fill + save
node skills/chrome-web-store/scripts/dashboard.mjs status                  # what still blocks submit
```

`all` creates the item, uploads the zip, fills the store listing, the privacy tab and visibility, and saves after each. Single steps for repairs: `newitem | upload | listing [text|icon|shots] | privacy | distribution | save`. Use **`fill`** instead of `all` against an item that already exists - **`all` mints a new item every time**, so re-running it on a published extension produces a duplicate.

Two steps are deliberately **not** part of `all`:

```sh
node .../dashboard.mjs certify   # ticks the three compliance attestations
node .../dashboard.mjs submit    # submits for review - irreversible
```

The certifications are the developer's own legal statement and submission cannot be undone. Run them only when the developer explicitly asks, and only after checking each statement is true of the extension.

**Verify with `status`, never with the fill log.** It reports the item status, ID, whether Submit is enabled, and the dashboard's own blocker list. This matters more than it sounds: the dashboard silently swallows interactions, and two settings once shipped wrong (visibility stuck on Public, remote code on Yes) while the script reported success. Every mutating helper now re-reads the page and throws if the change did not land.

The full catalogue of dashboard traps - beforeunload wedging CDP, Material radios ignoring label clicks, `.type()` timing out on long text, `networkidle2` never firing, the two-stage submit dialog - is in **[docs/CHROME-WEB-STORE-AUTOMATION.md](../../docs/CHROME-WEB-STORE-AUTOMATION.md)**. Read it before changing `dashboard.mjs`.

## Step 3 - first publish (dashboard, once per extension)

The API can't create a listing, so the first release is manual:

1. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole): **Items -> Add new item -> Upload** the zip from Step 1. This creates the item and its **ID** (in the URL - save it).
2. **Store listing:** product name, Summary (<=132) and Description, Category, Language, and upload the padded screenshots. All listing copy - name, summary, description, category, language, single-purpose, permission justification, privacy URL, visibility - lives in the extension's `store-listing.md` (e.g. `extensions/notion-comment-recovery/store-listing.md`).
3. **Privacy practices tab** (in the item's left-hand menu, not the main dashboard): single-purpose statement + host-permission justification (both in `store-listing.md`); **Remote code: No** (all code ships in the package; it only fetches data, no eval/remote scripts - if it errors "justification required," the toggle is still on Yes); the data-usage declaration (this repo's extensions collect/transmit nothing) + tick the compliance certification; and the **privacy-policy URL** (the extension's `PRIVACY.md` GitHub URL - it must be **pushed and publicly reachable**, or review fails on a dead link; verify it loads before pasting).
4. **Settings page:** set and **verify** a publisher contact email - publishing is blocked until the email is verified.
5. **Visibility:** Unlisted (shareable link) for a team tool, or Public. **Submit for review.**
6. Save the item ID for Step 5.

## Step 4 - API credentials (once)

Four secrets; keep them out of git:

1. [Google Cloud Console](https://console.cloud.google.com): create/pick a project and **enable the "Chrome Web Store API."**
2. Configure the **OAuth consent screen**: audience **External** (Internal is Workspace-only), then **Publish app / In production**. Testing mode causes two failures - refresh tokens expire in 7 days, and consent returns **403 `access_denied`** for anyone not on the Test-users list. (Alternative to publishing: add your email under **Test users**, accepting the 7-day expiry.) Then create an **OAuth 2.0 Client ID**, application type **Desktop**; note the **client ID** and **client secret**.
3. Get a **refresh token** (loopback flow, no deps):
   ```sh
   CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... node skills/chrome-web-store/scripts/get-refresh-token.mjs
   ```
   It opens the consent screen (redirects to `http://localhost:8976`), then prints `CWS_REFRESH_TOKEN=...`. An **unverified-app** warning is expected - Advanced -> proceed (your own app; `chromewebstore` is a sensitive, not restricted, scope, so no formal verification is needed).
4. **Store the credentials** so publishing needs no copy-paste. The client secret + refresh token are passwords; the extension ID + client ID are public. Two options:

   **A - OS keyring (recommended; encrypted, no plaintext file).** With the `CWS_*` vars set in your shell (Steps 1-3), run:
   ```sh
   node skills/chrome-web-store/scripts/cws-keychain.mjs store   # check | clear also
   ```
   Uses macOS Keychain or Linux libsecret (`secret-tool`); `cws-publish.mjs` then reads them automatically.

   **B - env file (portable, headless-friendly).** `~/.config/cws-publish.env`, `chmod 600`, plain `KEY=value`, loaded per-run with Node's `--env-file` (Step 5). Use this on a headless Linux box (no keyring daemon) or as the transfer medium between machines.

   **Another machine:** keyrings don't sync. On the new box, either re-run `get-refresh-token.mjs` to mint a fresh token there (cleanest - no secret leaves the first machine), or securely copy an env file (B) once and `cws-keychain.mjs store` from it. The refresh token is long-lived once the consent app is In production.

## Step 5 - publish updates (API)

```sh
npm install   # one-time, in skills/chrome-web-store/scripts
node skills/chrome-web-store/scripts/make-zip.mjs extensions/<name>
# creds from the OS keyring (Step 4-A):
node skills/chrome-web-store/scripts/cws-publish.mjs extensions/<name>-cws.zip
# or, with an env file (Step 4-B):
node --env-file="$HOME/.config/cws-publish.env" skills/chrome-web-store/scripts/cws-publish.mjs extensions/<name>-cws.zip
```

`make-zip.mjs` needs no credentials. With the keyring, `cws-publish.mjs` loads the secrets itself (nothing printed); with the env file, `--env-file` supplies them - never `cat` that file into a transcript. `--id=<extId>` overrides the extension ID (it is public).

Re-package (Step 1) first so the zip has the bumped version. Flags:
- `--upload-only` - upload a draft without publishing (review in the dashboard, then re-run without it). **Use this on the first API run.**
- `--target=trustedTesters` - publish to your testers group instead of the public.

It uploads the package to `CWS_EXTENSION_ID` and publishes, printing the upload state and publish status.

## Categories

Pick one in the dashboard's Store listing tab. The selectable categories (2026), by group:
- **Productivity:** Communication, Developer Tools, Education, Tools, Workflow & Planning
- **Lifestyle:** Art & Design, Entertainment, Games, Household, Just for Fun, News & Weather, Shopping, Social Networking, Travel, Well-being
- **Make Chrome Yours:** Accessibility, Functionality & UI, Privacy & Security

The three group names (Productivity / Lifestyle / Make Chrome Yours) are headers, not selectable. A Notion / collaboration / productivity tool like notion-comment-recovery -> **Workflow & Planning**.

## Cautions

- The API updates the **package** only. New screenshots or changed copy still go through the dashboard.
- Publishing can go to **review**; it isn't instantly live. Rejections arrive by email + in the dashboard.
- `uploadState: FAILURE` means wrong item ID, bad zip, or the version didn't increase.
- `cws-publish.mjs` is untested against a live account (no credentials in-repo) - first real run, use `--upload-only`.

## Portability

Self-contained under `skills/chrome-web-store/`. `make-zip.mjs` and `pad-screenshot.mjs` need only Node + macOS `sips`; `cws-publish.mjs` needs `chrome-webstore-upload` (`npm install` in `scripts/`).
