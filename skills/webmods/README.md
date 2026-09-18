# webmods

A Claude skill that scaffolds a new [Tampermonkey](https://www.tampermonkey.net/) userscript and its dev loader, then guides building the feature.

## Use it

From the root of a userscript repo:

```
node skills/webmods/scripts/new-userscript.mjs \
  --name "Slack Quick Edit" \
  --match "https://app.slack.com/*" \
  --desc "Double-click your own Slack message to edit it"
```

It writes `scripts/<slug>.user.js` with a filled metadata header, verifies the target-site favicon, registers the script in `greasyfork.json` + the README table when those exist, and prints the dev-loader block to paste into Tampermonkey for live reload.

Needs **Node 18+** (uses global `fetch`). See [SKILL.md](SKILL.md) for the full flow (scaffold -> test -> build -> publish) and the flag reference.

## Share it

Self-contained. Copy the `skills/webmods/` directory into any userscript repo. The `greasyfork.json`/README steps auto-detect and skip when those files are absent, so the core scaffold works anywhere.

MIT. See [LICENSE.txt](LICENSE.txt).
