# Privacy Policy - Slack DM Blur

_Last updated: 2026-07-28_

Slack DM Blur is a browser extension that adds a toggle to Slack's Direct Messages header. While the toggle is on, the extension applies a CSS blur to the rows of your DM list so that people watching your screen cannot read them.

## What it does with data

- It stores **one value** in the Slack page's own `localStorage`, under the key `tms:slack-dm-blur`: `1` if blur is on, `0` if it is off. That is the entire state it keeps, and it never leaves your browser.
- It reads no message content, no contact names, and no account information. The blur is a visual style applied to the page; the extension does not need to know what the rows say and does not look.

## What it does NOT do

- It makes **no network requests of any kind**. There is no server behind this extension.
- It does **not** collect, store on any external server, or transmit any of your data to the developer or any third party.
- It contains **no** analytics, tracking, advertising, or telemetry.
- It requests **no** browser permissions at all, and runs **only** on `app.slack.com`.

## What it does not protect against

Blur hides rendered pixels, not the underlying page. Someone with access to your machine can still read the DM list through browser devtools, and the extension does not cover an open conversation, the quick switcher, notification toasts, or the browser tab title. It defeats shoulder-surfing and screenshares, not an attacker at your keyboard.

## Contact

Questions or issues: open an issue at <https://github.com/KakkoiDev/webmods>.
