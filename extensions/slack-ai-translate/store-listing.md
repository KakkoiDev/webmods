# Chrome Web Store listing - Slack AI Translate

Canonical, paste-ready copy for the Developer Dashboard listing. Written to CWS limits (summary <= 132 chars, description <= 16000).

- **Product name:** Slack AI Translate
- **Item ID:** _TBD - minted by the dashboard on first publish. Record it here, then export as `CWS_EXTENSION_ID` or pass `--id=` to `cws-publish.mjs` (the Keychain currently holds the Notion extension's ID, so `--id=` is mandatory until this is set)._
- **Category:** Communication (`CATEGORY_COMMUNICATION`)
- **Language:** English
- **Store icon:** `store-icon-128.png` (128x128; 96x96 artwork + 16px transparent padding per CWS guidelines). Do NOT use the manifest's `icons/icon-128.png` here - those are full-bleed for the toolbar.
- **Visibility:** Unlisted (shareable by direct link, not shown in search).
- **Privacy policy URL:** https://github.com/KakkoiDev/webmods/blob/main/extensions/slack-ai-translate/PRIVACY.md (must be pushed and publicly reachable before submitting - review fails on a dead link)
- **Remote code:** No - all executable code ships in the package. No eval, no remote scripts, no `@require` from a CDN. The extension sends text to AI providers and receives text back; it never fetches code.
- **Contact email:** already set and verified on the dashboard from the previous submission.

## Summary (<= 132 chars)

```
Translate any Slack message or your own draft between English and Japanese, using your own Gemini, Claude, or local Ollama key.
```

## Description (<= 16000 chars)

```
Slack AI Translate puts a globe button on every Slack message and on the message composer. Click it to translate - the message is replaced in place, and a "See original" link toggles back.

It works in both directions automatically. English becomes Japanese, Japanese becomes English; no language picker, no copy-pasting into another tab.

HOW IT WORKS

- Hover any message and click the globe in its toolbar. The translation replaces the text where it stands, keeping Slack's formatting: links, code blocks, @mentions and emoji come through untouched.
- Click the globe in the composer to translate your own draft before you send it. The draft stays editable while it translates, and typing dismisses the toggle so a translation can never overwrite an edit you just made.
- Scroll away and back: translated messages stay translated.

BRING YOUR OWN AI

There is no server behind this extension and no subscription. You pick a provider and paste your own API key:

- Google Gemini - free API key from Google AI Studio. The default.
- Anthropic Claude - API key from the Anthropic Console.
- Ollama - a model running locally on your own machine. Nothing leaves your computer at all.

Right-click the composer's globe to open settings, choose a provider, and paste the key. You can also change the model, and edit the translation prompt itself if you want different languages or different rules.

PRIVACY

Only the message you click is sent, and only to the provider you configured. Nothing is read or transmitted in the background, there is no analytics or telemetry, and there is no server belonging to this extension. Your API key is kept in the extension's own storage, where the Slack page itself cannot read it. Choose Ollama and no text leaves your machine.

Your provider's own terms govern what they do with the text you send them.

WHO IT'S FOR

Bilingual teams working in one Slack. If half your channels are in a language you read slowly, and you would rather not keep a translation tab open next to Slack all day, this removes that step.

HONEST LIMITS

- English and Japanese by default. Other language pairs work only if you edit the prompt in settings.
- Translation quality is the model's, not the extension's. A small local model will be noticeably worse than Gemini or Claude.
- It runs on Slack in the browser (app.slack.com), not in the Slack desktop app.
```

## Single purpose

```
Translate Slack messages and message drafts between English and Japanese in place, using an AI provider the user configures with their own API key.
```

## Data usage declarations

Tick these categories, because they are true:

- **Personal communications** - the text of the Slack message or draft you click is sent to your chosen AI provider so it can be translated.
- **Authentication information** - the API key you enter is stored locally and sent to that provider to authenticate the request.

Then certify all three, all of which hold:

- Not being sold to third parties, outside of approved use cases.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

## Permission justifications

**Host access to `generativelanguage.googleapis.com` and `api.anthropic.com`**

```
These are the translation providers the user chooses between. When the user clicks the translate button, the extension sends that one message's text, plus the user's own API key, to the provider they selected, and displays the translated text it returns. No request is made until the user clicks, and no other host is contacted.
```

**Host access to `http://localhost/*` and `http://127.0.0.1/*`**

```
The third provider option is Ollama, an AI model the user runs locally on their own machine, which listens on localhost. Users who choose it get translation without any text leaving their computer. If the user has not configured Ollama, these hosts are never contacted.
```

**`storage`**

```
Stores the user's settings: which provider they chose, their API key, the model name, and their translation prompt. Using extension storage rather than the page's localStorage keeps the API key out of reach of scripts running on the Slack page.
```

**`declarativeNetRequestWithHostAccess`**

```
Used for exactly one rule: removing the Origin header from the extension's own requests to the translation providers listed above. Ollama rejects any request carrying an Origin header, so without this the local-model option cannot work at all; fetch() cannot remove that header, and declarativeNetRequest is the only API that can. The rule is scoped with tabIds: [-1], so it applies only to the extension's own background requests and never modifies requests made by web pages. It does not block, redirect, or read any traffic.
```

## Screenshots

Three are built and ready to upload, each exactly 1280x800. Upload order matters - the first is the one people see:

1. `store-screenshot-1.png` - composer before/after, "Translate your draft before you send it"
2. `store-screenshot-2.png` - a received message, "Every message you receive gets a translate link"
3. `store-screenshot-3.png` - the settings dialog, "Bring your own key: Gemini, Claude, or a local Ollama model"

Uploading them is manual; the API cannot do screenshots.

They were composed rather than padded, because the raw captures (402x251, 542x252, 491x78) would have needed a 2-3x upscale to fill the frame:

```sh
node skills/chrome-web-store/scripts/frame-screenshot.mjs extensions/slack-ai-translate/store-screenshot-1.png \
  --shot=before.png --shot=after.png --scale=1.15 --caption="Translate your draft before you send it"
```

Capture only from a self-DM or a scratch channel - whatever is on screen becomes public on the listing.

Shot 3 is captured **from the shipped code**, not by hand, so it can never show stale UI. Regenerate it whenever the settings dialog changes:

```sh
node tools/shot-slack-translate-dialog.mjs /tmp/dialog.png
node skills/chrome-web-store/scripts/frame-screenshot.mjs extensions/slack-ai-translate/store-screenshot-3.png \
  --shot=/tmp/dialog.png --scale=0.45 --caption="Bring your own key: Gemini, Claude, or a local Ollama model"
```

It loads the real generated content script in a headless extension, injects the composer anchor so the script's own button and `openSettings()` run, and screenshots the dialog element at 2x.

**Known weakness:** shot 2 shows a received message *before* translating - the "See translation" link is visible but no translation is. A capture of that message after translating, with Japanese text and "See original", would be a stronger shot and could take the lead position.
