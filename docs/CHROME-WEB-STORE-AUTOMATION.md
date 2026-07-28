# Automating the Chrome Web Store dashboard: what breaks

Every failure below was hit for real while publishing `slack-ai-translate` on 2026-07-27 and `slack-dm-blur` on 2026-07-28, and every one is now handled in `skills/chrome-web-store/scripts/dashboard.mjs`. They are written down because the expensive ones were not "it threw an error" - they were **"it reported success and changed nothing"**.

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
- `puppeteer.connect({browserURL})`, and **`disconnect()`, never `close()`** - the window belongs to the user.
- Port 9222 is open to any local process while that Chrome runs. Quit it when done.

**The sign-in is one-time, and the launch afterwards is not.** The restriction is on *authenticating* under automation, not on *running* an already-authenticated profile. `~/.cache/chrome-web-store/chrome-profile` keeps the Google session between runs, so on every later publish an agent can start that Chrome itself, unattended, with the exact command above - no human in the loop. Confirmed on 2026-07-28: the profile signed in a day earlier attached straight to the dashboard.

So the sequence for an agentic run is: check the port, launch if nothing answers, then attach.

```sh
curl -s -m 2 http://127.0.0.1:9222/json/version   # empty -> not running, launch it
curl -s http://127.0.0.1:9222/json/list | grep -o '"url": "[^"]*"' | head -3
```

A `devconsole/<uuid>/` URL in that listing means the session is live. A redirect to `accounts.google.com` means the profile logged out and a human has to sign in once more - `attach()` detects that and says so rather than timing out.

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
| `ElementHandle.click()` on a `>>>`-pierced element | `Node is either not clickable or not an Element`, or hangs | Compute the rect in-page, then `page.mouse.click(x, y)`, or click in-page |
| `ElementHandle.click()` on an unfocused window | `Runtime.callFunctionOn timed out` after the **full** `protocolTimeout` (4 min) | `page.bringToFront()` on attach, and prefer an in-page `el.click()`. `ElementHandle.click` scrolls into view through the compositor, and a tab Chrome is not painting never produces the frame it waits for. This is why `newitem` hung on "Add a new item" while every other step worked |
| `ElementHandle.evaluate()` on a pierced element | CDP call hangs until `protocolTimeout` | Use `page.evaluate` and find the element inside the page |
| `.type()` for a long description | `Runtime.callFunctionOn timed out` at ~2400 chars | `page.keyboard.sendCharacter(value)` - one `Input.insertText`, not one event per character |
| `el.value = text` + synthetic `input`/`change` | **Reports the right character count, saves an empty field** | See below - never assign `.value` |
| Clicking a Material **radio's label** | Returns cleanly, radio unchanged | Find the real `input[type=radio]` (32x32) via the nearest ancestor text, click it, **then verify `.checked`** |
| Picking a long dropdown option | `not clickable` for anything below the fold | `scrollIntoView` inside the overlay first - the list scrolls in its own container |
| Reusing a `data-*` tag between runs | `waitForSelector` matches a stale element | Clear previous tags before tagging |
| Multi-file upload | `Multiple file uploads only work with <input type=file multiple>` | The screenshots input is **not** `multiple` - one file per call, re-finding the input each time because the component re-renders |
| `waitUntil: 'networkidle2'` | Never resolves | This SPA keeps connections open. Use `domcontentloaded` + `waitForSelector` |

Also: **options exist in the DOM while the menu is closed** (as 0x0 elements), so element presence does not mean the menu is open - check visibility.

## The worst one: a whole tab that filled nothing

The privacy tab reported `single purpose: 145 chars`, `host justification: 336 chars`, `privacy url: 82 chars`, saved a draft - and was completely empty afterwards. Two bugs stacked:

1. **`__label` walks *up* the tree**, so "the first visible element whose label starts with *Single purpose description*" is the **section wrapper `<div>`** (1185x1977), matched long before the textarea inside it.
2. **Assigning `.value` to a `<div>` succeeds.** It just creates a JS property. The read-back `el.value.length` then returns exactly what was written, so the verification passed while no form control had ever been touched.

Both fixes are needed:

- Match only real controls: `TEXTAREA`, or `INPUT` of type text/url/search/email (`__editable` in the script).
- Put text in as **real browser input** - `page.mouse.click` the field, select-all, `Backspace`, then `page.keyboard.sendCharacter(value)`. `Input.insertText` produces an input event from the renderer, which the form's own model actually observes.

Why assigning `.value` is unsafe even on the *right* element: the value sits in the DOM while the Angular model stays empty, so the field looks correct until anything re-renders that section - clicking the remote-code radio is enough - and then it repaints from the empty model and the draft saves blank.

**Corollary, and the rule to keep: an in-session read-back proves nothing.** The only trustworthy check is `page.reload()` and re-read. Every field claimed above survived a reload before the item was submitted.

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
