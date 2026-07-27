# Automating the Chrome Web Store dashboard: what breaks

Every failure below was hit for real while publishing `slack-ai-translate` on 2026-07-27, and every one is now handled in `skills/chrome-web-store/scripts/dashboard.mjs`. They are written down because the expensive ones were not "it threw an error" - they were **"it reported success and changed nothing"**.

The single most important lesson:

> **The dashboard silently swallows interactions.** A click can land on the right element, return cleanly, and do nothing. Never trust a step that only reports what it *did*; make it re-read the page and prove what *changed*.

Two settings shipped wrong because of this - visibility stayed **Public** when the script said "Unlisted", and remote code stayed **Yes** when it said "No". Both were caught only by asking the dashboard's own validator what still blocked submission.

## Sign-in

**Google refuses to sign in inside a Puppeteer-launched Chrome.** You get *"This browser or app may not be secure."* No user-agent or flag tweak reliably beats it - Google is detecting the automation launch itself.

The fix is to never authenticate under automation. The user launches an ordinary Chrome with a debugging port and signs in by hand; the script only ever attaches:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/chrome-web-store/chrome-profile" \
  "https://chrome.google.com/webstore/devconsole" &
```

- The **separate `--user-data-dir` is required**, not hygiene: Chrome refuses `--remote-debugging-port` on the default profile (2025 security change).
- The profile persists, so this is a one-time sign-in.
- `puppeteer.connect({browserURL})`, and **`disconnect()`, never `close()`** - the window belongs to the user.
- Port 9222 is open to any local process while that Chrome runs. Quit it when done.

**Importing the module must not launch a browser.** An early version ran its CLI dispatch at import time, so a throwaway script that imported one helper spawned a second Chrome and tripped the automation block - producing a mystifying sign-in popup mid-run. Guard the CLI:

```js
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
```

## Native dialogs wedge everything

The dashboard raises a **beforeunload prompt** ("Leave site? Changes you may have made will not be saved") on any navigation with unsaved edits. A native dialog blocks the renderer, and then **every** later CDP call times out - including `puppeteer.connect` itself, with `Network.enable timed out`. The symptom points nowhere near the cause.

```js
page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
```

Separately, the in-page **"Unable to publish" / "submitted for review" dialogs** are not native but still swallow every subsequent click. Dismiss them before acting - `attach()` clears one on connect, and `__dismiss()` runs before each navigation.

## Finding elements

The dashboard is Angular Material: heavy shadow DOM, auto-generated ids.

- **Element ids shift between renders** (`c11`, `c31`, `c46`). Never anchor on them.
- **Everything needs a shadow-root walk.** A plain `querySelector` reaches almost nothing.
- **Labels are the only stable handle**, and they resolve three different ways. Try `aria-labelledby`, then `aria-label`, then the nearest `<label>` up the tree - the Description textarea has *only* the last, so a script checking `aria-label` alone reports "field not found".

## Interactions that fail

| What | Symptom | Fix |
|---|---|---|
| `ElementHandle.click()` on a `>>>`-pierced element | `Node is either not clickable or not an Element`, or hangs | Compute the rect in-page, then `page.mouse.click(x, y)` |
| `ElementHandle.evaluate()` on a pierced element | CDP call hangs until `protocolTimeout` | Use `page.evaluate` and find the element inside the page |
| `.type()` for a long description | `Runtime.callFunctionOn timed out` at ~2400 chars | Set `.value`, then dispatch `input` + `change` |
| Clicking a Material **radio's label** | Returns cleanly, radio unchanged | Find the real `input[type=radio]` (32x32) via the nearest ancestor text, click it, **then verify `.checked`** |
| Picking a long dropdown option | `not clickable` for anything below the fold | `scrollIntoView` inside the overlay first - the list scrolls in its own container |
| Reusing a `data-*` tag between runs | `waitForSelector` matches a stale element | Clear previous tags before tagging |
| Multi-file upload | `Multiple file uploads only work with <input type=file multiple>` | The screenshots input is **not** `multiple` - one file per call, re-finding the input each time because the component re-renders |
| `waitUntil: 'networkidle2'` | Never resolves | This SPA keeps connections open. Use `domcontentloaded` + `waitForSelector` |

Also: **options exist in the DOM while the menu is closed** (as 0x0 elements), so element presence does not mean the menu is open - check visibility.

## Saving and submitting

- **Unsaved changes are lost on any reload**, and there is no warning beyond the beforeunload prompt. Save after each tab, not once at the end. One renderer wedge cost a full re-fill of the privacy tab because of this.
- **"Submit for review" only opens a confirmation dialog.** The dialog's own *"Submit For Review"* button is what submits. A run that clicks the first button and stops reports success while the item stays in Draft.
- **The status header lags the submission by several seconds.** Reading it once right after confirming returns a stale `Draft`. Poll until it changes.
- Ask the dashboard **"Why can't I submit?"** for the authoritative blocker list. Do not infer readiness from your own logs.

## What cannot be automated, by design

- **The first publish needs the dashboard.** The CWS API cannot create a listing, set copy, upload screenshots, or answer the privacy tab, and the item ID only exists once the dashboard mints it. Version updates *are* API-automatable (`cws-publish.mjs`).
- **Screenshots are dashboard-only** even after the item exists.
- **`certify` and `submit` are separate opt-in steps**, never part of `all`. The three compliance checkboxes are the developer's own legal attestation and submission is irreversible - a script should run them only on an explicit instruction, after each statement has been checked against what the extension actually does.
- **`all` creates a new item every time.** Use `fill` against an already-open item to edit an existing listing, or you get a duplicate.

## Expect a slow review for permissioned extensions

The dashboard warns inline: *"Due to the Host Permission, your extension may require an in-depth review which will delay publishing."* `slack-ai-translate` declares four hosts plus `declarativeNetRequestWithHostAccess` and transmits personal communications, so it is squarely in that bucket - unlike `notion-comment-recovery`, which declares no permissions at all.

## Verifying a run

`node .../dashboard.mjs status` prints the item status, its ID, whether Submit is enabled, and the dashboard's own blocker list. That, not the fill log, is the check that matters.
