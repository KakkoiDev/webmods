# Publishing a companion extension to the Chrome Web Store

How to register a Chrome Web Store (CWS) developer account and publish a generated extension from this repo. Worked example: `extensions/notion-comment-recovery`.

Unpacked/dev-mode is fine for testing, but colleagues can't use it. The Web Store gives a real one-click install with auto-update. Firefox/Edge and the tradeoffs are in [EXTENSIONS.md](EXTENSIONS.md); this guide is Chrome-only.


## Automating the dashboard

The dashboard-only steps (create item, listing copy, screenshots, privacy answers, visibility) are driven by `skills/chrome-web-store/scripts/dashboard.mjs` against a Chrome you signed in to yourself. See the [chrome-web-store skill](../skills/chrome-web-store/SKILL.md) for the commands.

Before changing that script, read **[CHROME-WEB-STORE-AUTOMATION.md](CHROME-WEB-STORE-AUTOMATION.md)** - every dashboard trap hit while publishing `slack-ai-translate`, most of which fail by silently doing nothing rather than by throwing.

## 1. Register the developer account (one-time)

1. Go to the **[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)** and sign in with the Google account you want to own the listings (a work/team account is better than a personal one - the listings belong to whoever owns it).
2. Accept the developer agreement and pay the **one-time US$5 registration fee**.
3. Set your **publisher details** (a display name; verify the contact email). You can publish under a personal name or set up a group publisher later.

That's the whole account setup. It's paid once, not per extension.

## 2. Project setup (per extension)

Everything below is already done for `notion-comment-recovery` - this section is the checklist for it and for the next one.

### a. Icons
CWS requires a 128px icon; the manifest also references 16/32/48. They're generated from an SVG:

```sh
node tools/make-icons.mjs extensions/notion-comment-recovery/icon.svg extensions/notion-comment-recovery/icons
```

The manifest declares them under `"icons"`. To change the art, edit `icon.svg` and re-run.

### b. Manifest
Already valid for CWS: `manifest_version: 3`, `name`, `version` (auto-synced from the userscript `@version`), `description` (<= 132 chars), `icons`, `minimum_chrome_version`, and the `content_scripts` block. `notion-comment-recovery` declares **no permissions and no `host_permissions`** (it runs in `world: MAIN` and only makes same-origin Notion fetches), which keeps review light.

### c. Privacy policy (required)
CWS requires a privacy policy URL for anything that touches user data. This repo hosts one per extension: `extensions/notion-comment-recovery/PRIVACY.md`. Use its GitHub URL in the listing:

```
https://github.com/KakkoiDev/webmods/blob/main/extensions/notion-comment-recovery/PRIVACY.md
```

### d. Screenshots (you must capture these)
The one thing that can't be generated - CWS needs at least one **1280x800** or **640x400** screenshot (up to 5). On a real logged-in Notion page with comments:
1. Open the panel (the "N comments" badge, top-right) and screenshot it showing a few threads.
2. A second showing a **deleted-block** thread (red pill) and the Restore/Re-attach buttons is worth including - it's the headline feature.
Crop/pad to exactly 1280x800 or 640x400.

### e. Build the upload zip
CWS wants a `.zip` of the extension's **runtime files only** (not `source.json`, `README`, `icon.svg`, `.gitignore`, or `_metadata/`):

```sh
cd extensions/notion-comment-recovery
zip -r ../notion-comment-recovery-cws.zip manifest.json notion-comment-recovery.js icons
cd -
```

## 3. Create the listing and submit

In the Developer Dashboard: **Items -> Add new item -> upload the zip**. Then fill in:

**Store listing**
- **Product name:** Notion Comment Recovery
- **Summary** (<= 132): paste from the appendix.
- **Description:** paste from the appendix.
- **Category:** Workflow & Planning
- **Language:** English
- **Store icon:** upload `store-icon-128.png` (128x128, with the art at 96x96 centered + 16px transparent padding, per the CWS image guidelines - no edge bleed). The manifest's `icons/icon-128.png` is full-bleed for the toolbar; don't use it as the store icon.
- **Screenshots:** upload yours from step 2d.

**Privacy tab**
- **Single purpose:** paste from the appendix.
- **Permission justification:** paste from the appendix (host access to Notion only).
- **Data usage:** declare that the extension does **not** collect or transmit user data (it doesn't - all local + same-origin Notion). Check the "not being sold to third parties" and "not used for unrelated purposes" boxes.
- **Privacy policy URL:** the GitHub URL from step 2c.

**Distribution**
- **Visibility:** **Unlisted** shares by direct link without appearing in search (matches how the userscripts are published here, good for a team tool). **Public** if you want it discoverable. Either is one-click install.
- Submit for review. Review is usually hours-to-days; broad host permissions would slow it, but this one has none.

## 4. Publishing updates

The version must increase on every update, and it's automatic here: edit the source `scripts/notion-comment-recovery.user.js`, commit (the pre-commit hook bumps the `@version` and regenerates the extension `.js` + manifest `version`), push, then re-zip (step 2e) and upload the new zip in the dashboard -> submit. Same listing, new version.

Later, this can be automated end to end: CWS has a publish API (`chrome-webstore-upload` / the Web Store API), so a skill could push updates the way the `greasyfork` skill does for userscripts - no dashboard clicking. Not built yet.

## Appendix - paste-ready listing copy

_Canonical source: [extensions/notion-comment-recovery/store-listing.md](../extensions/notion-comment-recovery/store-listing.md) (also has category, language, visibility). This mirrors it - edit that file._

**Summary (<= 132 chars)**
```
See every comment Notion stores for a page - open, resolved, and on deleted blocks or removed anchors - in one panel, with export and restore.
```

**Description**
```
Notion Comment Recovery shows you every comment Notion still stores for the page you're on - not just the ones you can see. Comments don't always disappear when they look gone: delete the block a comment is on, or remove the text it was anchored to, and Notion hides the comment while quietly keeping the record. This extension surfaces all of it in one panel, lets you export it, and can bring deleted comments back.

WHAT IT SHOWS

Open the "comments" badge in the top-right of any Notion page to see, in one place:
- Open comments and their replies.
- Resolved comments.
- Orphaned comments - ones whose anchor text was edited away, so Notion stopped showing them inline.
- Deleted-block comments - comments on blocks that were deleted. Notion hides these but keeps the records; the panel brings them back into view.
- Deleted comments - comments that were removed entirely, recovered from a local cache if they were seen while you browsed.

Filter the list by All / Deleted / Resolved / Open, and read a per-thread status pill so you always know what state each comment is in.

WHAT YOU CAN DO

- Export the page's comments to a Markdown file - a clean, dated archive with author names, timestamps, block titles, and anchor text.
- Copy any single thread to the clipboard.
- Jump to a live comment ("Go") to scroll straight to it on the page.
- Restore a deleted block, so its comment reappears inline - put back in its original position when that can be recovered from history.
- Re-attach an orphaned comment to its block, so it shows up again as a block-level comment.
- See a purge countdown on deleted blocks - an estimate of how many days remain before Notion permanently removes a trashed block, so you can rescue a comment before it's gone for good.

Restore and re-attach write to your workspace, so they're always behind a confirmation.

HOW IT FINDS COMMENTS

It pulls from four sources, all through Notion's own API using your existing login - no token, no setup:
- The live page tree - every open and resolved comment.
- The page's orphaned-discussion records - anchor-removed comments.
- Version history - a deep scan of past snapshots recovers comments on blocks deleted long ago.
- A passive cache - while you browse, it records the comments Notion loads, so a comment survives in the archive even after its block, or the comment itself, is deleted. This is the only way to catch deletions that happen before a version snapshot exists.

Every comment is then categorized by the current state of its block, and comments that belong to other pages (backlinks, mentions, your inbox) are filtered out.

PRIVACY

Everything runs locally in your browser. The extension reads only your own Notion data, through Notion's API, using your existing session - and sends nothing to any other server. There is no analytics, no tracking, no telemetry, and it asks for no special browser permissions; it runs only on Notion pages. The small local cache it keeps to recover deleted comments never leaves your browser and is cleared when you clear the site's data.

HONEST LIMIT

It can only recover comments that Notion snapshotted in version history, or that were seen live while the extension was running. A comment that was created and then deleted before it was ever captured - no snapshot, never browsed with the extension active - can't be recovered, because nothing references it anymore. This is a real limit of what's retrievable, not a bug.

WHO IT'S FOR

Anyone who relies on Notion comments for decisions, feedback, or records and has been burned by one vanishing when a block was deleted or edited. If you've ever thought "there was a comment here and now it's gone," this is for you.
```

**Single purpose**
```
Surface and recover the comments Notion stores for the current page - including comments whose block or anchor was deleted - in one panel, with export to Markdown and one-click restore.
```

**Permission justification** (host access to `notion.so` / `notion.com`)
```
The extension runs only on Notion pages and reads the page's own comment and discussion data through Notion's same-origin API, using your existing logged-in Notion session. This host access is required to list, export, and restore the page's comments. No other permissions are requested and no data is sent anywhere other than Notion.
```
