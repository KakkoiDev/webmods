# Testing a Chrome extension headlessly

The Tampermonkey dev loop (edit `.user.js`, reload the tab) does not cover the extension build. Every bug found in the `slack-ai-translate` port lived in the part Tampermonkey never exercises: MV3 CORS rules, the service worker, `chrome.storage`, and request headers. Those are testable headlessly, against real local services, before touching a browser by hand.

This is the technique that found and proved the `Origin` regression (2026-07-27).

## Setup

Puppeteer is already installed under `skills/greasyfork/scripts/node_modules`. Borrow it rather than adding a dependency, the same way `tools/make-icons.mjs` does:

```js
import { createRequire } from 'node:module';
const require = createRequire('/path/to/repo/skills/greasyfork/scripts/');
const puppeteer = require('puppeteer');

const browser = await puppeteer.launch({
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
});
```

`headless: true` loads MV3 extensions fine. The old "extensions require headful Chrome" advice is stale.

Put throwaway harnesses in the scratchpad, not the repo. They are evidence for one change, not a suite.

## Pattern 1: drive the service worker directly

The cleanest way to test the network layer. No page needed.

```js
const target = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
const worker = await target.worker();
const result = await worker.evaluate(async () => {
    const r = await fetch('http://localhost:11434/api/chat', { method: 'POST', body: '…' });
    return { status: r.status, text: await r.text() };
});
```

Expose helpers on `self` in the worker if you need to call them repeatedly.

## Pattern 2: drive the content script

A content script runs in an isolated world, so `page.evaluate` cannot call into it. Hand results back through the DOM, which both worlds share:

```js
// in the content script
document.documentElement.setAttribute('data-result', JSON.stringify(results));

// in the harness
await page.waitForFunction(() => document.documentElement.hasAttribute('data-result'), { timeout: 30000 });
const results = JSON.parse(await page.$eval('html', (el) => el.getAttribute('data-result')));
```

Collect `page.on('pageerror')` and `page.on('console')` too, and assert the error list is empty. A script that throws halfway still sets some state.

## Pattern 3: two local servers, for a genuine cross-origin test

Same host, different port, is a different origin. Serve the page on one port and the fake API on another. Omit `Access-Control-Allow-Origin` so a page-context fetch genuinely fails, and have the API echo back what it received:

```js
res.end(JSON.stringify({ method: req.method, gotBody: body, hasOrigin: 'origin' in req.headers }));
```

Echoing `hasOrigin` is how the header-stripping rule was proved.

## Pattern 4: always include the control case

This is the part that makes the rest worth anything. Assert that the thing which *should* fail still fails:

- a direct content-script `fetch` cross-origin is blocked, while the service-worker relay succeeds - proves the relay is necessary, not cargo cult
- a page-initiated request still carries its `Origin`, while the worker's does not - proves the `declarativeNetRequest` rule is scoped and is not breaking every localhost dev server in the browser
- for a bug fix: run the request **without** the fix first and watch it fail, then with it. That is the regression test when the code has no unit-test seam

## Test against the real local service

Where a provider runs locally, hit it. The `Origin` fix was verified against the actual Ollama on `localhost:11434` with `gemma4:latest`, not a mock. A mock would have happily accepted the header that the real server rejects.

`curl` first to establish ground truth, then reproduce in the browser. The gap between the two *is* the browser-specific bug:

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:11434/api/chat -H 'Content-Type: application/json' -d '…'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:11434/api/chat -H 'Origin: https://example.com' -d '…'
```

## Use the real generated artifacts

`copyFileSync` the actual `extensions/<name>/*.js` into the throwaway extension, or point `--load-extension` at the real directory. Never retype the code into the harness - then you are testing your transcription.

To test just the shim prelude, slice it off the generated file and assert the slice is non-empty:

```js
const prelude = generated.slice(0, generated.indexOf('// ==UserScript=='));
if (!prelude.includes('function GM_xmlhttpRequest')) throw new Error('shim prelude not found');
```

## Gotchas hit so far

- **Throwaway manifests must declare the same `permissions` as the real one.** The bridge calls `chrome.declarativeNetRequest` at startup; without the permission the service worker throws immediately and every test fails for an unrelated reason.
- **`chrome.runtime.reload()` inside `worker.evaluate` hangs CDP** with `ProtocolError: Runtime.callFunctionOn timed out` - the worker dies before it can answer. Fire and forget, then re-acquire the worker target.
- **A 403 with an empty body** parses to `null` JSON and surfaces as a bare `HTTP 403`. Log the raw status and body in the harness, not just the parsed object.
- **`page.evaluate` cannot see content-script globals.** If a value is unreachable, it is the isolated world, not a bug.

## Known-good facts established by these runs

- MV3 content scripts have no cross-origin privileges; the relay through the service worker is required, not optional.
- A service-worker `fetch` always sends `Origin: chrome-extension://<id>`, and `fetch` cannot remove it (`Origin` is a forbidden header name). Only `declarativeNetRequest` can.
- A `declarativeNetRequest` session rule scoped `tabIds: [-1]` applies to the extension's own background requests and leaves page requests alone.
- A service worker can read its own extension's files fresh from disk via `fetch(chrome.runtime.getURL(...))` - unpacked edits are visible without reloading the extension.
