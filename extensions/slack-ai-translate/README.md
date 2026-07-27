# Slack AI Translate (Chrome extension)

The `scripts/slack-ai-translate.user.js` userscript, packaged as a Chrome extension so colleagues can install it in one click without Tampermonkey.

The userscript stays the single source of truth; `slack-ai-translate.js` and `gm-bridge.js` here are **generated** from it by `tools/build-extensions.mjs` (wired into the pre-commit hook), pointed by `source.json`. The generator also syncs this extension's `manifest.json` version to the userscript's `@version`. Never edit the generated files by hand - edit `scripts/slack-ai-translate.user.js`.

## Why it's shaped this way

- **Isolated world (no `world` key)** - the script touches no page globals and no `unsafeWindow`, and `chrome.storage` / `chrome.runtime` only exist in the isolated world.
- **`run_at: "document_idle"`** - the userscript declares no `@run-at`, so Tampermonkey runs it at `document-end`. It appends to `document.head`/`document.body` with no readiness guard, so `document_start` would break it.
- **`gm-bridge.js` service worker** - the userscript grants `GM_xmlhttpRequest`. MV3 gives content scripts no cross-origin privileges, so the generated shim relays each request to this service worker, which fetches it with the extension's `host_permissions`.
- **`host_permissions`** - one per `@connect` in the userscript: Gemini, Anthropic, and Ollama on localhost. Match patterns ignore the port, so `http://localhost/*` covers `:11434`. A custom Ollama host outside `localhost`/`127.0.0.1` will not work here (host permissions are static).
- **`permissions: ["storage"]`** - the API keys live in `chrome.storage.local`, not in `localStorage` on `app.slack.com` where any script on the page could read them.
- **`permissions: ["declarativeNetRequestWithHostAccess"]`** - Tampermonkey's `GM_xmlhttpRequest` sends no `Origin` header and Ollama 403s any request that carries one, but a service-worker `fetch` cannot drop `Origin`. The bridge registers a session rule that strips it from its own requests only (`tabIds: [-1]`), so Ollama works with no `OLLAMA_ORIGINS` setup and page requests to localhost are untouched.
- **`minimum_chrome_version: 134`** - the settings dialog uses the HTML `closedby="any"` attribute (`scripts/slack-ai-translate.user.js:528`) to dismiss on an outside click, which is Chrome 134+. Everything else here works from Chrome 116.

## Install (unpacked, for testing)

1. `chrome://extensions` -> **Developer mode** on -> **Load unpacked** -> select this folder.
2. Open Slack in the browser. A globe icon appears in the composer toolbar and in each message's hover toolbar.
3. **Right-click the composer's globe** to open settings, pick a provider, and paste its API key.

**Disable the Tampermonkey version first.** Both inject the same buttons, and their settings are stored separately (Tampermonkey's own storage vs the extension's `chrome.storage.local`), so running both is confusing rather than harmful.

## Settings do not carry over from the userscript

The extension has its own storage. On first run you re-enter the API key here, even if the Tampermonkey copy already has one.

## Distribution

Unpacked is dev-only. For colleagues, this goes on the Chrome Web Store as an **unlisted** item. Store assets are ready: [`store-listing.md`](store-listing.md) (paste-ready copy, data-usage answers, per-permission justifications), [`PRIVACY.md`](PRIVACY.md), and `store-icon-128.png`. Build the upload bundle with `node skills/chrome-web-store/scripts/make-zip.mjs extensions/slack-ai-translate`.

**Status: submitted for review 2026-07-27**, item ID `cmoodpgkclmmhjbppfcbhjnljpmlmbnp`, Unlisted, set to publish automatically once it passes. The dashboard warned that the host permissions trigger an in-depth review, so expect this to take longer than a permission-free extension.

The whole dashboard flow was driven by `skills/chrome-web-store/scripts/dashboard.mjs` (see the skill for how it attaches to a signed-in Chrome). Version updates from here use the API: `make-zip.mjs` then `cws-publish.mjs --id=cmoodpgkclmmhjbppfcbhjnljpmlmbnp`. Walkthrough: [CHROME-WEB-STORE.md](../../docs/CHROME-WEB-STORE.md).
