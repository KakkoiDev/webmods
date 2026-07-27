# Companion Chrome extensions

Some userscripts are also shipped as Chrome extensions so people can install them in one click, without setting up Tampermonkey. The userscript stays the **single source of truth**; the extension is a generated build output.

## The rule: edit the userscript, never the generated extension code

- You only ever edit `scripts/<name>.user.js`. The extension's content-script `.js` is **generated** from it, with a `// GENERATED ... do not edit` banner.
- The extension's `manifest.json` is hand-written (it holds extension-only metadata: `world`, `matches`, `run_at`, permissions). Its `version` is **auto-synced** from the userscript's `@version` by the generator.
- `tools/build-extensions.mjs` does the generation. Each `extensions/<name>/source.json` points it at the source: `{ "userscript": "scripts/<name>.user.js", "out": "<name>.js" }`.
- The **pre-commit hook** (`.githooks/pre-commit`) runs the generator on every commit that touches a `.user.js` or a `source.json` and re-stages the output - so the extension copy can never drift from the source, exactly like `gen-readme` keeps the README table in sync with `greasyfork.json`.
- Hand-authored extensions with **no `source.json`** (e.g. `csp-unlock`) are left untouched by the generator.
- Chrome regenerates a `_metadata/` folder when it loads an unpacked extension; it is gitignored per extension.

## Add a new companion extension from a userscript

1. `mkdir extensions/<name>/`
2. Write `extensions/<name>/manifest.json` (MV3), mapping the userscript header:
   - `@match` -> `content_scripts[].matches`
   - `@run-at` -> `run_at` (`document-start` -> `document_start`)
   - **`world`**: use `"MAIN"` if the script needs the page's realm - reading page globals, or hooking the page's own `fetch`/`XMLHttpRequest` (e.g. `notion-comment-recovery`). Use the default isolated world only for pure DOM scripts. `world: "MAIN"` needs `"minimum_chrome_version": "111"`.
   - `@grant`: the generator injects a shim per grant (see the table below). It **errors out** on a grant it has no shim for, rather than emit an extension that silently does nothing - add the shim to `SHIMS` in `tools/build-extensions.mjs`. Note: `chrome.*` APIs exist only in the isolated world, so a script needing **both** MAIN world and `chrome.storage` can't have both - resolve per script.
   - `@connect` -> `host_permissions`: **manual**, like `@match`. Bare `@connect` hostnames don't map cleanly onto match patterns (`localhost` -> `http://localhost/*`, and match patterns ignore the port), so the generator doesn't sync them.
3. Write `extensions/<name>/source.json` pointing at the userscript.
4. Add `extensions/<name>/.gitignore` containing `_metadata/`.
5. Run `node tools/build-extensions.mjs` to generate the `.js` (or just commit - the hook does it).
6. Load unpacked (`chrome://extensions` -> Developer mode -> Load unpacked) to test. If the userscript version injects into the same world, disable it first (e.g. scripts guarded by a global like `__NOC_ARMED__` let only the first instance win).

## `GM_*` shims

`tools/build-extensions.mjs` prepends a shim for each `@grant` the userscript declares, above the copied body. What's implemented today (worked example: `slack-ai-translate`):

| `@grant` | Shim | Extra manifest |
|---|---|---|
| `GM_xmlhttpRequest` | `chrome.runtime.sendMessage` to a generated `gm-bridge.js` service worker, which does the `fetch` | `"background": { "service_worker": "gm-bridge.js" }` + `host_permissions` + `"permissions": ["declarativeNetRequestWithHostAccess"]` |
| `GM_getValue` / `GM_setValue` / `GM_deleteValue` | `chrome.storage.local` | `"permissions": ["storage"]` |

Two contract differences that will bite:

- **`GM_getValue` returns a Promise here**, because `chrome.storage` is async, where Tampermonkey returns the value directly. A script must `await` it to work in both. The pattern in `slack-ai-translate.user.js` is a one-shot `hydrate()` into an in-memory cache, so the rest of the script keeps reading settings synchronously.
- **The `GM_xmlhttpRequest` shim covers only the subset the repo's scripts use**: `onload` / `onerror` / `ontimeout`, and `status` / `responseText`. No `onprogress`, no `abort()`, no `responseType`, no binary. Extend the shim before relying on more.

Why `GM_xmlhttpRequest` can't just be a `fetch` in the content script: MV3 removed content-script cross-origin privileges, so a direct `fetch` is an ordinary CORS request from the page's origin, and an `http://localhost` call from an https page also hits mixed-content / Private Network Access rules. The service worker has the host permissions; the content script doesn't.

And why the bridge needs `declarativeNetRequestWithHostAccess`: Tampermonkey's `GM_xmlhttpRequest` sends **no `Origin` header**, and scripts depend on that. A service-worker `fetch` always sends `Origin: chrome-extension://<id>`, and `fetch` cannot remove it - `Origin` is a forbidden header name. Ollama, for one, answers **403 to any request carrying an `Origin`**, including a `chrome-extension://` one, so the extension broke a provider that worked fine under Tampermonkey. The bridge registers a `declarativeNetRequest` **session rule** that strips `Origin` from its own requests, scoped by `tabIds: [-1]` so page-initiated requests to the same hosts keep theirs (otherwise this extension would quietly break CORS for every localhost dev server in the browser). The generator refuses to emit the bridge if the manifest doesn't declare the permission.

## Distribution channels

Colleagues can't freely sideload on Chrome, so "which store" matters. As of 2026-07:

| Channel | Reach | Notes |
|---|---|---|
| **Chrome Web Store** | Chrome/Chromium, one click | Main channel. $5 dev account, review (days). Broad host permissions get extra scrutiny; **CSP-disabling / "exotic" extensions (like `csp-unlock`) will likely be rejected.** |
| **Microsoft Edge Add-ons** | Edge, one click | Accepts the **same Chromium code**, separate (often faster) review. Useful as a parallel channel while Chrome review is pending. Same rejection risk for exotic extensions. |
| **Firefox AMO + self-distribution** | Firefox, one click | Closest thing to "F-Droid freedom": you can **self-distribute a signed XPI** (submit to AMO as *unlisted* for signing, host the file yourself, users install via web download). Firefox permits what Chrome forbids - **the venue for exotic extensions**. Cost: porting to Firefox's WebExtension quirks (`world:MAIN`, `declarativeNetRequest`, and MV3 details differ from Chrome). |
| **Enterprise force-install** | Managed browsers only | Chrome/Edge admins can force-install a non-store `.crx` from a self-hosted URL via policy (machines must be domain-joined). The path if colleagues are on managed Chrome. |

Step-by-step Chrome Web Store registration + submission (worked example: notion-comment-recovery): **[CHROME-WEB-STORE.md](CHROME-WEB-STORE.md)**.

Key realities:
- **There is no F-Droid-equivalent open store for Chrome.** Chrome auto-disables sideloaded `.crx`; non-store installs are dev-mode (with a startup nag) or enterprise force-install only. Self-distribution freedom lives on **Firefox**.
- **Reach follows the browser.** An Edge or Firefox listing only helps colleagues who use that browser.
- **For faster iteration / exotic extensions:** Edge (parallel review, same code) for speed; Firefox self-hosted signed XPI for anything Chrome/Edge reject.

## The project was renamed to `webmods`

Formerly `tampermonkey-scripts` - the old name only covered the userscript half; `webmods` names what it actually is: userscripts **and** the Chrome extensions generated from them.

The one non-automatic part of a repo rename: every Greasy Fork script syncs from a raw GitHub URL containing the repo name (`raw.githubusercontent.com/<owner>/<repo>/...`), and GitHub's rename redirect is not reliable for raw URLs - so each script's sync-from-URL was re-pointed with `node skills/greasyfork/scripts/release.mjs all` after the rename. Everything else auto-redirects: git clone/fetch/push and web links keep working, and `greasyfork.json` derives owner/repo from `git remote`, so it follows automatically. (If the CWS listing's privacy-policy URL used the old repo name, update it in the dashboard too.)
