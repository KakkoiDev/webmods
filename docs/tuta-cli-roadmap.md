# Tuta janitor as a CLI (lightpanda + bash)

The userscript is step one. The goal is to drive the same mailbox automation from a **CLI** -
[lightpanda](https://lightpanda.io/) to reach `window.tutao`, bash to script around it - so mailbox
hygiene can be cron'd, piped and composed instead of requiring an open tab with Tampermonkey
configured.

API surface and its traps: [RESEARCH-tuta-window-tutao.md](RESEARCH-tuta-window-tutao.md).

## What ports cleanly

The janitor is already split so that only the panel is UI. These are pure data-in/data-out and move
across unchanged:

| Piece | Shape |
|---|---|
| `scanFolders()` | folder names -> `[{id, folder, from, name, subject, date, unread, unsub}]` |
| `groupBySender()` | mails -> per-sender aggregates |
| `matches()` / `inScope()` / `dryRun()` | (mails, rules) -> `{byRule, byTarget, kept, total}` |
| `applyPlan()` | plan -> moves |
| config JSON | already a portable file - see [`presets/`](../presets) |

A CLI is then roughly: `scan` (emit JSON), `plan` (rules + scan -> plan JSON), `apply` (plan -> moves),
with the same dry-run-first and never-permanently-delete guarantees.

## The one thing to verify first

**Do not build the CLI layer until a headless session can log in.**

`window.tutao.locator` is only populated *after* Tuta derives your keys - Argon2 plus WebCrypto - and
spins up its web worker. This is not "fetch a page and read a global": the headless browser has to
execute Tuta's full crypto path and its worker, or the model simply is not there. Nothing above works
without it.

So milestone zero is narrow and binary:

```
lightpanda session reaches  logins.isUserLoggedIn() === true
```

Prove that, and the rest is a port. If lightpanda cannot run Tuta's crypto or its web worker, the
fallback is CDP against real headless Chromium with a persisted profile - heavier, but it is known to
work, since that is exactly how the script was developed and verified.

## Credentials

Logging in needs the account password, which rules out committing it anywhere. Options, roughly in
order of preference: a persisted browser profile that is already logged in (no secret in the repo), the
OS keychain read at runtime, or an env var for throwaway/test accounts only.
