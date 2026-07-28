# Slack DM Blur (Chrome extension)

The `scripts/slack-dm-blur.user.js` userscript, packaged as a Chrome extension so colleagues can install it in one click without Tampermonkey.

The userscript stays the single source of truth; `slack-dm-blur.js` here is **generated** from it by `tools/build-extensions.mjs` (wired into the pre-commit hook), pointed by `source.json`. The generator also syncs this extension's `manifest.json` version to the userscript's `@version`. Never edit the generated `.js` by hand - edit `scripts/slack-dm-blur.user.js`.

## Why it's shaped this way

- **`world: "MAIN"`** - the userscript is `@grant none`, which in Tampermonkey means the page's own realm. MAIN reproduces that exactly: the same `localStorage`, the same `window`, and therefore the same cross-tab `storage` event the script uses to keep two Slack tabs in sync.
- **`run_at: "document_start"`** - the stylesheet has to be in place before Slack paints a DM row, or blur-on-reload flashes readable names. The style blurs every row until the script has read its state (`html:not(.tms-dm-blur-ready)`), so a failure to boot fails *closed*.
- **No permissions / host_permissions** - it only adds a button and a CSS rule to `app.slack.com`. No network, no storage API, no service worker.
- **`minimum_chrome_version: 111`** - `world: "MAIN"` in a static content script needs Chrome 111+.

## Install (unpacked, for testing)

1. `chrome://extensions` -> **Developer mode** on -> **Load unpacked** -> select this folder.
2. Open `app.slack.com`. A **Blur** switch appears next to **Unreads** in the Direct Messages header (and in the hover peek card). `Alt+Shift+B` toggles it too.

**Running the Tampermonkey copy at the same time is fine.** Both inject into the MAIN world, and the script arms `window.__TMS_DM_BLUR_ARMED__` on first run so the second instance returns immediately. Without that guard both would register the keyboard backstop and one `Alt+Shift+B` press would toggle twice, i.e. do nothing.

## Known caveat to verify

`world: "MAIN"` + `document_start` injection ordering vs the page's own scripts isn't guaranteed as tightly as Tampermonkey's. If you ever see a readable flash of the DM list on reload with blur on, that's the stylesheet losing the race - the toggle itself still works.

## Distribution

Chrome Web Store listing copy and assets live in [`store-listing.md`](store-listing.md); the process is in [docs/CHROME-WEB-STORE.md](../../docs/CHROME-WEB-STORE.md).
