# greasyfork skill

Publish and keep userscripts in sync on Greasy Fork (greasyfork.org) from a git repo. Greasy Fork has no write API, so reads use its public JSON API and writes drive a local browser (Cloudflare requires the user's own machine/IP).

## One-time setup
1. Have `ego-browser` (ego lite) on `PATH` - the browser tools drive it instead of launching a browser of their own. Set `EGO_BROWSER_BIN` to point elsewhere.
2. The first browser command opens Greasy Fork's sign-in page in ego-browser's `greasyfork release` task space. Log in once (any method); the session lives in the browser's cookie jar, so later runs reuse it. Your login tab is never reloaded.

`verify` needs neither step - it uses only the public API and Node's built-in `fetch`.

`npm install --prefix skills/greasyfork/scripts` is still worth running, but no longer for this skill: it installs the Puppeteer that `tools/make-icons.mjs`, `tools/shot-*.mjs` and the chrome-web-store skill's `frame-screenshot.mjs` borrow from here.

## Discovery (works across agents)
Harness-agnostic (SKILL.md + Node scripts, agentskills.io frontmatter). Discovered from:
- **Claude Code**: `~/.claude/skills/greasyfork` (symlink to this dir).
- **pi / Codex / OpenCode**: `.agents/skills/greasyfork` in the repo (committed symlink to this dir) - the community-standard project location.

Commands use repo-relative paths and assume cwd = the userscript repo root, so they work from any harness here. From a different repo, prefix with wherever the skill is installed.

## Use
Run from the root of a repo that contains a `greasyfork.json` ([schema](references/manifest.md)):

| Task | Command |
|---|---|
| Check sync (read-only) | `node skills/greasyfork/scripts/verify.mjs` |
| Update after a push (sync drifted + verify) | `node skills/greasyfork/scripts/release.mjs [--push]` |
| Wire/re-point a script's sync URL | `node skills/greasyfork/scripts/release.mjs <id\|file\|all>` |
| Publish a new script | `node skills/greasyfork/scripts/register.mjs <file.user.js>` |
| List what's syncing | `node skills/greasyfork/scripts/status.mjs` |

## Troubleshooting
- **DRIFT in verify** - run `release.mjs`; Greasy Fork's webhook returns 403 to every push (server-side, never auto-pulls - see [greasyfork-model.md](references/greasyfork-model.md)). If still drifting after `release`: `@version` wasn't bumped, or the GitHub raw CDN is lagging (~5 min).
- **Stuck at login** - sign out of Greasy Fork in the ego-browser window and re-run to start a clean login.
- **Browser tool breaks after a Greasy Fork redesign** - the DOM selectors are centralized in `scripts/*.mjs` and documented in [references/greasyfork-model.md](references/greasyfork-model.md). `verify` (public API) keeps working regardless.

See [SKILL.md](SKILL.md) for the full model and recipes.
