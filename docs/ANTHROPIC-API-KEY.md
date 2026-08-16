# Anthropic API key — where it lives and how to get one

Notes from a 2026-08-16 hunt for the API key that the **Webmods Annotate** Chat tab
needs (`scripts/webmods-annotate.user.js` → Tampermonkey menu → *Configure AI chat…*).
Written down because the key is **not** where you'd expect, and the obvious page
tells you that you don't have permission.

## TL;DR

The key is **workspace-scoped**, not account-scoped. The page you want is:

```
https://platform.claude.com/settings/workspaces/wrkspc_01ErP8N6r8ZPVhdDc4T62b8c/keys
```

That's the **Claude Code** workspace in the `meetsmore` org (workspace created
2025-03-02). Bookmark it — there is no link to it from the main Console sidebar.

## Why the obvious path fails

`platform.claude.com/settings/keys` (the org-level page) shows:

> You need additional permissions to access organization API keys. Contact your
> organization's admin to request developer access.

That's because the account role is **Claude Code User** in `meetsmore`, which has
no org-level key permission. It is *not* the whole story though — org keys and
workspace keys are separate surfaces, and the workspace one is reachable.

Of the two workspaces:

| Workspace | Access |
|---|---|
| **Default** | "You don't have permission to view any resources in this workspace." |
| **Claude Code** (`wrkspc_01ErP8N6r8ZPVhdDc4T62b8c`) | Full manage surface: API keys, Rate limits, Spend limits, Members, Privacy controls, Security, Webhooks |

## Why an old key can't be recovered

Two independent reasons:

1. **Keys belong to the workspace, not to you.** The page says so directly:
   *"API keys are owned by workspaces and remain active even after the creator is
   removed."* So a key created earlier isn't attached to your account anywhere.
2. **The value is displayed exactly once**, at creation. Afterwards the list only
   ever shows a masked hint. Even finding the old key in the UI gives you nothing
   usable — the fix is always *create a new one, delete the old one*.

As of 2026-08-16 the workspace shows **0 keys**, so whatever existed before is gone.

## How to actually create one

The **Create key** button on that page is **disabled**, with this note:

> To create an API key in the Claude Code workspace, install Claude Code and then
> login with your Console account.

So in this workspace keys are *provisioned by a Claude Code login against a Console
account* — not by filling in a form. That is very likely how the previous key came
to exist ("created through the web interface without being an admin" = the login
flow, not a form).

⚠️ **Trade-off before doing this.** Claude Code on this machine currently
authenticates via the **claude.ai subscription** — that's the `Claude Code-credentials`
entry in the macOS Keychain. Re-logging in against a *Console account* swaps the
credential your daily Claude Code usage runs on, moving it from subscription
billing to API (per-token) billing. Don't do it casually.

**Preferred alternative:** ask an org admin for a separate key (or for Developer
access). It leaves the Claude Code login untouched, and a dedicated key is easier
to rate-limit and revoke. Admins are listed in
`platform.claude.com/settings/members` — filter for the **Admin** role (there is
also an `accounting` account with the *Billing* role; that's not the one you want).
Names deliberately not copied here since this repo is public.

Worth telling them: it's for direct browser-side Messages API calls from a local
userscript, so the key sits in local Tampermonkey storage. Some orgs prefer to
issue a scoped low-limit key for that, which is a perfectly good outcome.

## Where the key is *not*

Checked on 2026-08-16, all negative — don't re-search these:

- `ANTHROPIC_API_KEY` env var — unset
- `~/.zshrc`, `~/.zshenv`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.zprofile`
- `~/.zsh_history` — zero hits for both `sk-ant-` and `ANTHROPIC_API_KEY`
- `~/.config/anthropic/` — does not exist; `ant` CLI not installed
- `.env` files under `~/Code`
- Tampermonkey extension storage (ego lite profile) — zero `sk-ant-` occurrences
- macOS Keychain — only `Claude Code-credentials` and `Claude Safe Storage`

**claude.ai never issues API keys.** Not on Free, Pro, Max, Team, or Enterprise.
`sk-ant-` keys come only from the Console, under an organization. If you remember
"getting a key from claude.ai", that was the Claude Code OAuth login — a real
credential, but it authenticates as `Authorization: Bearer` with a beta header, so
it cannot be used in the `x-api-key` slot the userscript sends.

## Once you have a key

Tampermonkey menu on any page → **Configure AI chat…** → paste the key (starts with
`sk-ant-`) → optionally set a model → reload. The **Chat** tab then appears in the
annotate sidebar.

- Stored via `GM_setValue`, i.e. in Tampermonkey's extension storage — not in any
  site's `localStorage`, and excluded from JSON exports (there's a test locking
  that in: `annotate/test/chat.test.ts` → "never includes stored settings").
- Sent only to `api.anthropic.com`, only when you press **Send**.
- Bad key shows inline in the pane, e.g. `Claude API 401: invalid x-api-key`,
  and your question is preserved for retry.
- Cost: default `claude-opus-5` is $5/$25 per MTok (thinking tokens bill as
  output) — roughly a couple of cents per question. Cheaper options for the model
  prompt: `claude-sonnet-5` ($3/$15) or `claude-haiku-4-5` ($1/$5). Spend limits
  for this workspace live under **Manage → Spend limits** on the same Console page.

## If a key never materializes

Nothing else is blocked. Notes, text-range annotations, whiteboards, the sidebar,
`#wm-note=` links, JSON/Markdown export, and the All-pages browser are all local
and key-free. The Chat tab simply doesn't appear without a key.
