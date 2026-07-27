# Privacy Policy - Slack AI Translate

_Last updated: 2026-07-27_

Slack AI Translate adds a translation button to Slack messages and to the message composer. Translation is performed by an AI provider **you choose and configure with your own API key**.

## What it does with data

- **Message text is sent to the AI provider you selected.** When you click the translate button, the text of that one message - or of your own draft - is sent to whichever provider you configured: Google Gemini, Anthropic Claude, or an Ollama server running on your own machine. Nothing is sent until you click.
- **Your API key is sent to that same provider**, as required to authenticate the request. It is stored locally in the extension's own storage (`chrome.storage.local`), which is not readable by web pages, including Slack itself.
- **The provider's handling of that text is governed by their policy, not this one.** See Google's and Anthropic's terms for how they treat API input. If you pick Ollama, the text never leaves your machine.
- **Translations are cached in memory only**, for the current tab, so you can toggle between original and translation. The cache is discarded when the tab closes.

## What it does NOT do

- No data is sent anywhere except the AI provider you configured. There is no server belonging to this extension.
- No analytics, no tracking, no advertising, no telemetry.
- Nothing is read or transmitted in the background. It acts only on the specific message you click.
- It runs only on `app.slack.com`.

## Removing your data

Uninstalling the extension deletes its stored settings, including your API key. You can also clear them at any time from `chrome://extensions`.

## Contact

Issues and questions: https://github.com/KakkoiDev/webmods/issues
