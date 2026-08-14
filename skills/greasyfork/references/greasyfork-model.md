# Greasy Fork: how publishing actually works

Verified against Greasy Fork docs/behavior (2026). This is the mental model the scripts rely on.

## No write API
Greasy Fork exposes a **read-only** JSON API: `https://api.greasyfork.org/en/scripts/<id>.json` returns `version`, `name`, `code_url`, etc. There is **no** endpoint to create or update script code. Every write in this skill is therefore done by driving the real website in a local browser.

## Cloudflare => must run locally
Greasy Fork sits behind Cloudflare. The `cf_clearance` cookie is bound to the IP and User-Agent that solved the challenge. Automation must run on the **user's machine** (their IP) in a **real browser**; a server-side/curl request with copied cookies gets re-challenged and fails. Hence a real headful browser, not an HTTP client.

## Auth = the browser's own session
No API auth exists. `scripts/lib.mjs` drives **ego-browser** (ego lite) through `ego-browser nodejs`, in a named task space (`greasyfork release`) - an isolated set of tabs that shares the browser's cookie jar. The user logs in once in that visible window; the session outlives the space, so later runs find it already there.

`ensureLoggedIn` navigates once to `users/webhook-info` and looks for "Setting up a webhook". Logged out, Greasy Fork redirects that URL to its sign-in page, so the single navigation both tests the session and parks the user where they log in. The poll that follows is a same-origin `browserFetch` issued **from that same page** - not a navigation - so the login tab is never reloaded mid-input.

## Updates are a PULL, gated on @version
1. Script source is hosted at a public GitHub **raw** URL.
2. Each script is set to **Source Syncing** with that URL + sync type **Automatic** (script's Admin page).
3. Greasy Fork re-fetches and republishes when notified. `@version` **must increase** or the fetch is a silent no-op ("Greasy Fork will warn if it's not incremented when the code changes").
4. A **per-user webhook** (`greasyfork.org/en/users/<id>-<name>/webhook`, content type `application/json`, push event, no secret) added to the repo (Settings -> Webhooks) is *supposed* to make pushes near-immediate. **Reality (diagnosed 2026-06-15): this webhook endpoint returns `403` to every POST and cannot be made to work from our side.** Evidence: all GitHub deliveries 403 (`gh api repos/<o>/<r>/hooks/<id>/deliveries`); a POST from an authenticated browser session (user IP, valid Cloudflare clearance) also 403s; same for JSON and form-encoded bodies, push and ping events, and with a valid CSRF token. The 403 carries Rails headers (`X-Runtime` ~4ms, `X-Request-Id`), so it is Greasy Fork's **application** rejecting the POST - not Cloudflare, not the source IP, not a stale URL (the configured URL matches what `webhook-info` instructs). GET on the same path 404s, so the route is POST-only and exists. The dead webhook was deleted from the repo (it only 403-spammed); re-add it from `webhook-info` if Greasy Fork ever fixes the endpoint. Net: auto-pull never fires; **run `release.mjs` after every push** to force the pull. The raw GitHub CDN can also lag ~5 min independently, so `release.mjs` waits for raw to catch up before syncing.
5. Files must be edited **in place** (committed, then modified) so webhook payloads show them as *modified*, not *added* - newly *added* files in a push are skipped by Greasy Fork's webhook handler.

## Moving or renaming a script's file
The sync URL is **path-based**. Moving or renaming a `.user.js` (e.g. into a `scripts/` folder) changes its raw URL, so the configured sync URL goes stale and the next sync 404s - the published listing then just keeps its last version (no data loss, but it stops updating). After any move/rename you MUST re-point the affected scripts at the new raw URL: update the `file` field in `greasyfork.json` (the single source of the path), then run `release.mjs <id|file>` (or `all`), which re-points sync-from-URL and pulls. `release` derives the new URL from the manifest. Pure `git mv` renames don't bump `@version`, so nothing republishes - only the URL needs re-pointing.

## Stripped meta keys
Greasy Fork strips `@downloadURL`, `@updateURL`, `@installURL` and serves updates from its own `update.greasyfork.org` URLs. Don't bother setting them in source. `@namespace` + `@name` are the identity - changing either on update triggers a warning.

## Visibility (script type) - set at creation on /en/script_versions/new
Radio `script[script_type]`:
- `1` = **Public** user script (listed/searchable). Default.
- `2` = **Unlisted** ("not linked to from anywhere on Greasy Fork ... does not prevent others from accessing it if they know the URL"). Installable by direct link; excluded from search/listings. Sync + webhook work the same as public (confirmed).
- `3` = **Library** (intended to be `@require`-d, not installed directly).

## Form selectors (centralized knowledge; update here when Greasy Fork changes markup)
- New script: `/en/script_versions/new`. Code textarea `#script_version_code` (plain unless "Enable syntax-highlighting source editor" is checked - leave it off). Visibility radios `#script_script_type_1|2|3`. Submit `input[name="commit"]` ("Post script"). On success it redirects to `/en/scripts/<id>-<slug>`.
- Source syncing: script Admin page (`/en/scripts/<id>/admin` redirects to the slug). URL field `#script_sync_identifier`, sync-type radio `#script_sync_type_automatic`, submit `input[name="update-and-sync"]` ("Update and sync now").
- All forms carry a Rails `authenticity_token` hidden field - submitting via a real button click sends it automatically.
