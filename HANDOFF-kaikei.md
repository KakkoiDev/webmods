# Handoff: Kaikei Meet userscript + Kurau corpus

Written 2026-08-04. Two independent workstreams. The userscript is close to done; the corpus
is extracted but nothing has been made of it yet.

---

## Part 1 - the userscript

`scripts/kaikei-meet.user.js`, currently `v2026.08.04.12`. Untracked, never committed.
Loaded in Chrome via `scripts/kaikei-meet.dev-loader.user.js`, which `@require`s it from
disk. **The loader is what Tampermonkey reads** - the loaded file's own header is ignored at
runtime, so any new `@match` / `@grant` / `@connect` must be copied onto the loader too.

### The bug that ate the day, and its actual cause

Symptom: "Send to chat" needed two clicks, or reported success while nothing arrived.

I produced three wrong theories before getting data: the focus guard, the dedup guard, the
readiness race. The first two I disproved myself with revert checks. **Do not re-litigate
them.** The pattern to avoid: I kept writing Puppeteer harnesses that modelled my current
theory, so they passed, which proved nothing.

The real cause came from an on-screen trace the captain pasted:

```
Kaikei send result: no-agent
chat=opening agentSeen=false frames=0 hasFocus=true
+24228ms  readiness: no-frame after 12005ms
```

`frames=0`. **This Meet build renders chat in the Meet document, not in a
`chat.google.com/embed/*` iframe.** The script only recognised two shapes - that iframe, or
an old `<textarea>` - so an in-page contenteditable chat looked like no chat at all, and the
cross-origin bridge waited forever for a frame that never existed. Every theory before this
was about the bridge. The bridge was irrelevant.

### What is now in place

- `nativeChatBox()` finds Meet's in-page composer (`textarea` or `contenteditable`), and
  explicitly **excludes the Gemini composer**, which is also a same-origin contenteditable in
  the same document. Sending a chat line into it would ask Gemini the question instead of
  telling the room the answer. There is a harness assertion for exactly this.
- `waitForChatReady()` resolves `'native'` as soon as an in-page composer appears, so the
  send no longer sits out the full 12s frame timeout. Dropped 12.3s to 1.2s.
- `composerInsert()` / `sendAndVerify()` are shared by the Gemini path and the chat path.
  Both **verify the composer emptied** rather than trusting a click on an enabled button.
- `boxText()` / `isField()`: a `<textarea>` holds text in `.value` and leaves `textContent`
  empty forever. Reading `textContent` measured every textarea insert as zero.
- The cross-origin iframe bridge is still there and still passes its harness. Keep it - other
  Meet builds still use the frame.

### Harnesses (scratchpad, not committed)

`/private/tmp/claude-502/-Users-cyril-antoni-Code-firstmate/6eb04f9d-ed3b-4c99-8ddd-ffa249c5c42f/scratchpad/`

| File | Covers | Status |
|---|---|---|
| `inpage-chat.mjs` | in-page chat, no iframe, Gemini present | 3/3 pass |
| `gemini-parts.mjs` | composer length ceiling + busy composer | 3/3 pass |
| `twoclick.mjs` | iframe bridge, one click, cold open | 3/3 pass |
| `gemini.mjs` | Gemini priming, one message | 3/3 pass |
| `verify.mjs` | swallowed send clicks | pass |

They serve local HTML at the real origins via request interception, so origin checks execute.

### Second live datapoint (v10, 2026-08-04 afternoon)

The captain confirmed v10 opens the chat and lands the text in the composer, but nothing
clicks Send. So the in-page composer detection works live; the button finder did not.
v11 response, all mock-verified: multi-signal button search (aria-label / data-tooltip /
title / `jsname=SoqoBf` / material-icon ligature "send" / type=submit) walking outward from
the composer with Gemini's own send button excluded; `hardClick` sending the full
pointerdown-mousedown-mouseup-click sequence because Google widgets often act on
pointer/mouse events, not click; synthetic-Enter fallback when no button works, judged by
the composer emptying. 7/7 in `inpage-chat.mjs`, including icon-only, mousedown-only, and
no-button-at-all shapes.

### Live-confirmed (2026-08-04, v11)

The captain confirmed both flows against real Google Meet: "The fix to send to the chat
worked" and the Gemini priming arrived complete in one message (paste ends at 会計年度,
which is the payload's true last entry; Gemini replied "Ready / 準備完了"). If a future
build breaks it again, the trace panel appears bottom-right with a **Copy trace** button
listing every editable field, iframe, and button near an editable field with its label,
jsname, icon text, and disabled state.

### Still open

1. `DEBUG = true` at line ~50. Strip before committing.
2. Nothing in webmods is committed: `scripts/kaikei-meet.user.js`,
   `scripts/kaikei-meet.dev-loader.user.js`, `tools/gen-kaikei-terms.mjs` are all untracked.
3. Gmeet vs Gmail toolkit packaging is unresolved.

### Resolved 2026-08-04 (v12): every term now carries a note

All 181 terms have a note (was 50 of 181). The notes live in
`~/.claude/skills/kaikei/reference/glossary.md` under `# Part 3 - term notes` - a
`| Term | Note |` table that `tools/gen-kaikei-terms.mjs` merges onto each term's real
entry. NOT in the Anki decks; the earlier handoff said Anki and was wrong - the generator
reads notes only from glossary.md. The generator fails loudly on a note row whose term
matches no glossary entry, so a typo cannot silently ship a definition-free card.
Full payload is now ~31k chars in one Gemini message on the mock; on a real composer with
a lower ceiling the measured-split path delivers it in parts.

---

## Part 2 - the Kurau corpus

`~/Code/kurau-corpus/`. **Not a git repo, no remote, local only.** That is deliberate: the
material is a colleague's work product, gathered before he has been told.

### Standing constraint, in the captain's words

> "I'm only going to harvest public data and this is for a demo to the manager, not not all
> the managers, just one manager, my manager, so that he knows that this is an option. It's an
> MVP. I will ask Kurao san later."

**Public work product only.** No DMs, no private channels. Kurau has not been told. Do not
publish, push, or share any of this without the captain saying so explicitly.

### What is extracted

| Source | State |
|---|---|
| GitHub | **complete.** 793/793 PRs, zero failures |
| Google Drive | 30 of 31 files. One is blocked by Google policy (`13JBvHCNEGI1JnfGSXJN8zAjib9bvlpgR`, download disabled) |
| git | 459 commits, 29 `kurau/*` branches |
| Notion | **0 files. Not started.** |
| Slack | **0 files. Not started.** Deferred by the captain |

His own words, the corpus that matters:

| | items | chars |
|---|---|---|
| inline review comments | 2,098 | 640,923 |
| issue comments | 361 | 170,630 |
| review summaries | 362 | 50,730 |
| **total** | **2,821** | **862,283** |

Inline review comments are the highest-value source by a wide margin - long-form technical
reasoning in his own words, anchored to a file and a diff hunk.

### Extraction is scripted, and must stay that way

Captain's standing preference, recorded in `~/dotfiles/data/firstmate/captain.md`: all
scraping goes into a checked-in script, never into in-context tool calls. Two reasons - token
cost, and every `gh` process costs the captain one Automic Vault approval click.

- `~/Code/kurau-corpus/pull-drive.sh` - one rclone process for the whole Drive inventory,
  using `rclone backend copyid` with repeated ID/path pairs.
- `~/Code/kurau-corpus/pull-github.sh` - **one** `gh auth token` call, then curl for
  everything. Resumable; a PR whose three payloads exist and parse is skipped.

Two traps already paid for, both fixed in the script, do not reintroduce:

- **macOS `xargs -P` stdin contention.** Children inherit xargs' stdin and eat the work list.
  Signature: N workers complete exactly N items, then silence and exit 0. Replaced with
  `split -n r/6` and six serial background workers each reading its own chunk file.
- **The GitHub handle is not the git identity.** `--author=claudiofreitas` finds 0 commits.
  He commits as `kurau.freitas@meetsmore.com` under two display names.

### The actual gap

**`distilled/` does not exist. 862k chars are on disk and nothing has been made of them.**
This is where the work now is. Two deliverables were drafted as prompts and never dispatched:

- `distilled/work.md` - domain knowledge extracted from his 862k chars. Every claim cites a
  PR URL. Confidence-marked. Written so that **Kurau confirms or corrects rather than
  authors** - he has two months and is under health pressure; that framing is the whole point.
  No personality or health content.
- `distilled/unlanded-work.md` - the 29 `kurau/*` branches classified LANDED / ABANDONED /
  UNLANDED-LIVE / UNKNOWN, plus still-open PRs, priority-ordered by how hard each would be to
  reconstruct without him. **No `gh` calls** - use the corpus and the local checkout.

A dispatch attempt was blocked because `kurau-corpus` is not a git repo and is not registered
as a project. The captain chose "register the corpus as a project": `git init`, register it
local-only, then dispatch. That has not been done.

### Deliberately not built

A `/kurau-ai` persona skill. Pushed back on it as premature and the captain has not overruled
that. Retrieval over what he actually wrote is the thing with value; persona modelling is
mostly theatre and needs a refined corpus and his review first.

---

## Recommended order

1. Live-test the userscript in a real Meet call. Copy the trace if it fails. Everything in
   Part 1 is unverified until this happens.
2. `git init` the corpus, register it, dispatch the two distillation deliverables.
3. Notion extraction (scripted).
4. Glossary notes on the 131 bare terms.

Slack stays deferred unless the captain reopens it.
