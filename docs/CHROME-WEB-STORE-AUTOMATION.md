# Automating the Chrome Web Store dashboard: what breaks

Every failure below was hit for real while publishing `slack-ai-translate` on 2026-07-27 and `slack-dm-blur` on 2026-07-28, and every one is now handled in `skills/chrome-web-store/scripts/dashboard.mjs`. They are written down because the expensive ones were not "it threw an error" - they were **"it reported success and changed nothing"**.

The single most important lesson:

> **The dashboard silently swallows interactions.** A click can land on the right element, return cleanly, and do nothing. Never trust a step that only reports what it *did*; make it re-read the page and prove what *changed*.

Two settings shipped wrong because of this - visibility stayed **Public** when the script said "Unlisted", and remote code stayed **Yes** when it said "No". Both were caught only by asking the dashboard's own validator what still blocked submission.

## Sign-in

**Historical note (superseded 2026-08-14).** This tool used to run on Puppeteer, and Google refuses to sign in inside a Puppeteer-launched Chrome (*"This browser or app may not be secure"* - it detects the automation launch itself, and no user-agent or flag tweak reliably beats it). The workaround was for the human to start an ordinary Chrome with `--remote-debugging-port=9222` and a separate `--user-data-dir`, sign in by hand, and have the script `puppeteer.connect` to it. **That whole ritual is gone.** If you find it documented anywhere else, that page is stale.

The tool now drives **ego-browser** (ego lite) and never launches or attaches to a browser. Everything happens in a task space named `chrome web store`, an isolated set of tabs that inherits the user's login state and, crucially, **stays alive between runs of the script** - which is what lets `newitem` hand an open item to `upload` and `fill`. The step that used to mean "try to launch a browser and fail at Google's sign-in" now means "open the dashboard and tell me who is signed in":

```sh
node .../dashboard.mjs login     # -> "signed in - publisher: <name>", or exit 1
```

**The dev console is the one Google surface that still demands its own sign-in.** Measured on 2026-08-14: with the user's session inherited into ego-browser, `drive.google.com`, `mail.google.com` and `myaccount.google.com` all load fully authenticated, while both `chrome.google.com/webstore/devconsole` and `chromewebstore.google.com/devconsole` hard-redirect to the corporate IdP with a password field. So a human still signs in once. Two things make that cheap:

- It is once. The session lives in the browser's cookie jar, which outlives the task space (verified: a cookie set in one space is visible in the next, and survives `completeTaskSpace`). Later runs find it.
- The credentials go to the **IdP's** form, not Google's, so the automation heuristic that killed the Puppeteer path does not obviously apply. Confirmed working on 2026-08-14 - `login` reported `publisher: ahirusan3000` and `status` read a real item straight afterwards.

`attach()` is now "find the dashboard tab in the task space and select it". No tab at all -> it says to run `login`. A tab sitting on `accounts.google.com` -> it says the session is signed out, rather than hanging.

**Importing the module must not drive a browser.** An early version ran its CLI dispatch at import time, so a throwaway script that imported one helper spawned a second Chrome and tripped the automation block - producing a mystifying sign-in popup mid-run. Guard the CLI:

```js
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
```

## Native dialogs wedge everything

The dashboard raises a **beforeunload prompt** ("Leave site? Changes you may have made will not be saved") on any navigation with unsaved edits. A native dialog blocks the renderer, and then **every** later CDP call times out. The symptom points nowhere near the cause.

There is no `page.on('dialog')` to register on ego-browser. Instead `pageInfo()` resolves to `{ dialog: ... }` instead of the usual `{ url, title, ... }` while one is open, because page JavaScript is blocked - so the check is a read, and the clear is explicit:

```js
if ((await pageInfo()).dialog) await cdp('Page.handleJavaScriptDialog', { accept: true });
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
| Any selector-based helper (`click('sel')`, `uploadFile('sel', f)`, `waitForElement`) | `Element not found`, even for an element you can see | They resolve through `document.querySelector`, which reaches **nothing** inside these shadow roots. Compute the rect with `js()` + the shadow walk, then `click([x, y])` |
| Clicking through the compositor on an unpainted tab | Hangs for minutes | Prefer an in-page `el.click()`; it needs no frame. This is why `newitem` once hung on "Add a new item" while every other step worked |
| Typing a long description key by key | Times out at ~2400 chars | `cdp('Input.insertText', { text })` - one call, not one event per character. Verified at 2600 chars |
| **`pressKey('Meta+a')` to select-all** | **Accepted, selects nothing - the new text is appended to the old** | Measured: 2605 chars where 5 were expected. Select with `el.setSelectionRange(0, el.value.length)` in-page, then `Input.insertText` over the selection. That only moves the caret; the replacement is still a real renderer input event |
| `el.value = text` + synthetic `input`/`change` | **Reports the right character count, saves an empty field** | See below - never assign `.value` |
| Clicking a Material **radio's label** | Returns cleanly, radio unchanged | Find the real `input[type=radio]` (32x32) via the nearest ancestor text, click it, **then verify `.checked`** |
| Picking a long dropdown option | `not clickable` for anything below the fold | `scrollIntoView` inside the overlay first - the list scrolls in its own container |
| Reusing a `data-*` tag between runs | A stale element matches | Clear previous tags before tagging |
| Multi-file upload | `Multiple file uploads only work with <input type=file multiple>` | The screenshots input is **not** `multiple` - one file per call, re-finding the input each time because the component re-renders |
| Setting a file input in shadow DOM | No helper reaches it | `cdp('Runtime.evaluate')` for the element, then `cdp('DOM.setFileInputFiles', { objectId, files })`. Verified end to end |
| `waitUntil: 'networkidle2'` / `waitForNetworkIdle()` | Never resolves (it returns `false`) | This SPA keeps connections open. Poll for the control you need |
| `captureScreenshot(path, { fullPage: true })` | Silently gives you the viewport only | `fullPage` is ignored. Use `Page.getLayoutMetrics` + `Page.captureScreenshot` with `captureBeyondViewport` and write the base64 yourself - and expect no screenshot at all when no window is on screen (see [the runtime section](#a-screenshot-needs-a-window-nothing-else-does)) |

Also: **options exist in the DOM while the menu is closed** (as 0x0 elements), so element presence does not mean the menu is open - check visibility.

## The worst one: a whole tab that filled nothing

The privacy tab reported `single purpose: 145 chars`, `host justification: 336 chars`, `privacy url: 82 chars`, saved a draft - and was completely empty afterwards. Two bugs stacked:

1. **`__label` walks *up* the tree**, so "the first visible element whose label starts with *Single purpose description*" is the **section wrapper `<div>`** (1185x1977), matched long before the textarea inside it.
2. **Assigning `.value` to a `<div>` succeeds.** It just creates a JS property. The read-back `el.value.length` then returns exactly what was written, so the verification passed while no form control had ever been touched.

Both fixes are needed:

- Match only real controls: `TEXTAREA`, or `INPUT` of type text/url/search/email (`__editable` in the script).
- Put text in as **real browser input** - click the field at its computed rect, select its contents with `setSelectionRange`, then `Input.insertText`. That produces an input event from the renderer, which the form's own model actually observes.

Why assigning `.value` is unsafe even on the *right* element: the value sits in the DOM while the Angular model stays empty, so the field looks correct until anything re-renders that section - clicking the remote-code radio is enough - and then it repaints from the empty model and the draft saves blank.

**Corollary, and the rule to keep: an in-session read-back proves nothing.** The only trustworthy check is to reload the page and re-read. Every field claimed above survived a reload before the item was submitted.

## The ego-browser runtime itself

The page-driving half lives in `dashboard-page.js` and is not run by node: `dashboard.mjs` reads it and feeds it to `ego-browser nodejs`. Five things about that runtime cost real time to find.

| Trap | What happens | Fix |
|---|---|---|
| `require` plus top-level `await` | `Cannot determine intended module format because both 'require' and top-level await are present` - and since every step awaits, `require` is simply unavailable | `await import('node:fs')` |
| `js()` on a source with a top-level `return` | Auto-wrapped in an IIFE, so the value is **thrown away** and you get `null` - with no error | Pass exactly one explicit `(() => { ... })()`, always |
| No argument channel into the page | `js()` takes a string; there is no `page.evaluate(fn, ...args)` | Serialize arguments into the source (`evalPage` does this) |
| `cliLog` output is buffered until the process exits | A `fill` would print its entire log at the end - after the minutes in which it was the only sign of life. `stdio: 'inherit'` does not help; the buffering is inside ego | Progress goes to a file the page script appends and `dashboard.mjs` tails; the return value goes to a second file |
| **`Page.captureScreenshot` with no ego-browser window on screen** | **Blocks until CDP times out** (`CDP request timed out: Page.captureScreenshot`, 15s), on every tab | `recon()` catches it and carries on with the control dump. See below |

The task space is **reused and never completed**. Closing it would throw away both the signed-in session and the item left open for the next step.

### A screenshot needs a window; nothing else does

ego lite keeps its tabs alive with **no window on screen** (`System Events` reports zero windows while the app runs and the tabs answer normally). A renderer with no window is never composited, so it produces no frame and `Page.captureScreenshot` waits for one forever - `Page.bringToFront` succeeds and does not help, `Emulation.setDeviceMetricsOverride` does not either, and it happens on a blank `example.com` tab in a fresh task space just as much as on the dashboard. It is not the page and not the clip.

Everything else works windowless, which was worth measuring rather than assuming: `Runtime.evaluate`, `Page.getLayoutMetrics`, `DOM.setFileInputFiles`, **coordinate clicks** (`click([x, y])` ticked a checkbox and fired its handler) and **`Input.insertText`** (typed into the focused field) all behave normally. So a filling run is unaffected - only the diagnostic picture is lost.

`recon()` therefore treats the screenshot as optional: it logs `no screenshot (...)` and still writes the control dump, which is what an unattended run is actually read from. Open the ego-browser window if you want the picture.

## Saving and submitting

- **Unsaved changes are lost on any reload**, and there is no warning beyond the beforeunload prompt. Save after each tab, not once at the end. One renderer wedge cost a full re-fill of the privacy tab because of this.
- **"Submit for review" only opens a confirmation dialog.** The dialog's own *"Submit For Review"* button is what submits. A run that clicks the first button and stops reports success while the item stays in Draft.
- **The status header lags the submission by minutes, not seconds.** `slack-dm-blur` polled `Draft` for a full minute, the script threw *"still Draft - submission did not take"* - and the recon screenshot taken immediately afterwards already read **Pending review**. The poll window is now 3 minutes, and the error tells you to re-check with `status` first. **Never re-submit on that error**: that is how you end up with two items.
- Ask the dashboard **"Why can't I submit?"** for the authoritative blocker list. Do not infer readiness from your own logs. Note the button **disappears** once nothing blocks, so "blockers: (none reported)" is ambiguous - read `submitDisabled` alongside it.
- **The three compliance checkboxes are what keep Submit disabled** once every field is filled. `status` will show `submitDisabled: true` with no blockers listed until `certify` runs.

## Declarations must come from the listing file, and be set explicitly

`fillPrivacy` used to tick a **hardcoded** `['Personal communications', 'Authentication information']` - true for `slack-ai-translate`, which is where they were written, and false for the next extension. `slack-dm-blur` collects nothing, and its first fill declared two kinds of data collection it does not do.

Two rules came out of it:

- **Every declaration is parsed from the extension's own `store-listing.md`** (bolded bullets under `## Data usage declarations`), like the rest of the config. Nothing about a specific extension belongs in the script.
- **Set all nine categories explicitly, every run** - to `false` as well as `true`. Ticking only what is wanted leaves a wrong box from an earlier run untouched, and a correction run then silently keeps a claim the listing no longer makes.

An unknown category name in `store-listing.md` throws before the browser is touched, so a typo cannot quietly become "declared nothing".

## What cannot be automated, by design

- **The first publish needs the dashboard.** The CWS API cannot create a listing, set copy, upload screenshots, or answer the privacy tab, and the item ID only exists once the dashboard mints it. Version updates *are* API-automatable (`cws-publish.mjs`).
- **Screenshots are dashboard-only** even after the item exists.
- **`certify` and `submit` are separate opt-in steps**, never part of `all`. The three compliance checkboxes are the developer's own legal attestation and submission is irreversible - a script should run them only on an explicit instruction, after each statement has been checked against what the extension actually does.
- **`all` creates a new item every time.** Use `fill` against an already-open item to edit an existing listing, or you get a duplicate.

## Expect a slow review for permissioned extensions

The dashboard warns inline: *"Due to the Host Permission, your extension may require an in-depth review which will delay publishing."* `slack-ai-translate` declares four hosts plus `declarativeNetRequestWithHostAccess` and transmits personal communications, so it is squarely in that bucket - unlike `notion-comment-recovery`, which declares no permissions at all.

## Verifying a run

`node .../dashboard.mjs status` prints the item status, its ID, whether Submit is enabled, and the dashboard's own blocker list. That, not the fill log, is the check that matters.
