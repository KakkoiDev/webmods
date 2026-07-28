# Chrome Web Store listing - Slack DM Blur

Canonical, paste-ready copy for the Developer Dashboard listing. Written to CWS limits (summary <= 132 chars, description <= 16000).

- **Product name:** Slack DM Blur
- **Item ID:** _not yet submitted_. The first publish is dashboard-only and mints the ID; record it here afterwards, then pass `--id=<id>` to `cws-publish.mjs` for version updates (the Keychain's `CWS_EXTENSION_ID` holds a different extension's ID, so `--id=` is mandatory).
- **Category:** Communication (`CATEGORY_COMMUNICATION`)
- **Language:** English
- **Store icon:** `store-icon-128.png` (128x128; 96x96 artwork + 16px transparent padding per CWS guidelines). Do NOT use the manifest's `icons/icon-128.png` here - those are full-bleed for the toolbar.
- **Visibility:** Unlisted (shareable by direct link, not shown in search).
- **Privacy policy URL:** https://github.com/KakkoiDev/webmods/blob/main/extensions/slack-dm-blur/PRIVACY.md (must be pushed and publicly reachable before submitting - review fails on a dead link)
- **Remote code:** No - the single content script ships in the package. No eval, no remote scripts, no `@require` from a CDN. The extension makes no network requests at all.
- **Contact email:** already set and verified on the dashboard from the previous submissions.

## Summary (<= 132 chars)

```
Blur your Slack DM list with one toggle, so nobody reading over your shoulder can see who you talk to while you screenshare.
```

## Description (<= 16000 chars)

```
Slack DM Blur adds a "Blur" switch next to Unreads in Slack's Direct Messages header. Flip it on and every row of your DM list is blurred out, so the names and message previews are unreadable to anyone watching your screen. Flip it off and they come straight back.

It exists for the moment you share your screen in a meeting and remember, one second too late, that your entire DM list is on it.

HOW IT WORKS

- The switch sits inline with Slack's own Unreads toggle and matches its styling, in the full Direct Messages view and in the hover peek card.
- Alt+Shift+B toggles blur from anywhere in Slack, for when you need it before you can find the mouse.
- The setting sticks. Reload Slack and it comes back the way you left it, blurred before the list is ever drawn, so there is no readable flash on refresh.
- Two Slack tabs open? Toggling in one updates the other immediately.

WHAT IT COVERS

The Direct Messages list itself: every row, including rows recycled as you scroll. That is the surface that is almost always visible in a screenshare and almost never something you meant to show.

PRIVACY

There is no server behind this extension and it makes no network requests of any kind. It requests no browser permissions, it reads no messages, and it runs only on app.slack.com. The only thing it stores is a single on/off flag in the Slack page's own local storage, which never leaves your browser. No analytics, no tracking, no telemetry.

HONEST LIMITS

- It runs on Slack in the browser (app.slack.com). The Slack desktop app runs none of this.
- Blur hides rendered pixels, not the page underneath. It defeats shoulder-surfing and screenshares; it does not hide anything from someone with devtools on your machine.
- It covers the DM list, not everything else: an open conversation, the Cmd/Ctrl+K quick switcher, notification toasts and the browser tab title are all still readable.

WHO IT'S FOR

Anyone who screenshares from Slack. Support, sales, engineers pairing, anyone doing a demo - if your DM sidebar has ever been on a call recording, this is a one-click fix.
```

## Single purpose

```
Blur the rows of the Slack Direct Messages list behind a toggle, so they cannot be read by people viewing the user's screen during a screenshare.
```

## Data usage declarations

Tick **nothing**. The extension collects and transmits no user data: no network requests, no permissions, and its only stored state is a single on/off flag in the page's own local storage.

Then certify all three, all of which hold:

- Not being sold to third parties, outside of approved use cases.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

## Permission justifications

The extension declares **no `permissions` and no `host_permissions`**, so those fields should be empty. The only access it has is the content-script match on `app.slack.com`. If review asks about it:

```
The extension runs only on app.slack.com, where it adds one toggle button to the Direct Messages header and applies a CSS blur to the rows of the DM list while that toggle is on. It reads no message content and makes no network requests of any kind. The host match is required only to place that button and that style on the Slack page.
```

## Screenshots

`store-screenshot-1280x800.png`, a before/after pair with the blur off on the left and on on the right.

It is **generated, not captured**, by `tools/shot-slack-dm-blur.mjs` + `frame-screenshot.mjs`:

```sh
node tools/shot-slack-dm-blur.mjs
node skills/chrome-web-store/scripts/frame-screenshot.mjs \
  extensions/slack-dm-blur/store-screenshot-1280x800.png \
  --shot=/tmp/dm-blur-off.png --shot=/tmp/dm-blur-on.png --scale=1.0 --bg=4A154B \
  --caption="One switch before you share your screen"
```

The shot tool renders a stand-in DM list with invented names and runs the **real generated content script** against it in a headless extension. That is deliberate: a capture of the actual DM sidebar would publish colleagues' names on the store listing, which is exactly the content this extension exists to hide. It also means the shot can never show stale UI.
