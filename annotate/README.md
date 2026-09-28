# @webmods/annotate

Framework-agnostic TypeScript library for annotating arbitrary web pages: Markdown notes attached to page blocks, robust anchors that survive DOM changes, pluggable storage, a Notion-comments-style sidebar, shareable `#wm-note=` links, and JSON export/import.

Spec: [docs/webmods-annotate-spec.md](../docs/webmods-annotate-spec.md). This implements the spec's initial recommended scope (§36): core + robust block anchors + Tampermonkey shared storage + Markdown notes + notes sidebar + note anchor links + JSON import/export + minified one-import build.

The optional AI Chat tab needs a key from either provider. Anthropic keys are workspace-scoped and the obvious Console page refuses non-admins — see [docs/ANTHROPIC-API-KEY.md](../docs/ANTHROPIC-API-KEY.md). An OpenAI (or OpenAI-compatible) key is the self-serve alternative; pick the provider in the *Configure AI chat…* menu command.

## Roadmap

Implementation plans for the next features (robustness pass, text-range annotations, AI chat pane, global annotation browser, backlog) live in [plans/](plans/) — start at [plans/00-OVERVIEW.md](plans/00-OVERVIEW.md).

## Builds

```
npm install
npm run build     # dist/annotate.{js,min.js,esm.js,user.js} + ../scripts/webmods-annotate.user.js
npm test          # vitest unit tests
npm run typecheck
```

- `dist/annotate.js` / `dist/annotate.min.js` — browser global `WebmodsAnnotate`
- `dist/annotate.esm.js` — `import { createAnnotator } from "@webmods/annotate"`
- `dist/annotate.user.js` — reference Tampermonkey userscript (also copied to `scripts/webmods-annotate.user.js`)

## Usage

```ts
import { createAnnotator, createTampermonkeyStorage, createPortableDataPlugin } from "@webmods/annotate";

const annotator = createAnnotator({
  storage: createTampermonkeyStorage(), // or memory / localStorage / IndexedDB / custom
  onSaveNote(note) { console.log(note); },
});
annotator.use(createPortableDataPlugin());
annotator.enter(); // annotate mode; Alt+Shift+A toggles by default
```

Browser global:

```html
<script src=".../annotate.min.js"></script>
<script>
  const annotator = WebmodsAnnotate.create({ storage: WebmodsAnnotate.tampermonkeyStorage() });
</script>
```

## Architecture

- `src/annotator.ts` — lifecycle, modes, events, note CRUD, `#wm-note=` navigation, SPA hooks, plugin system, command registry
- `src/blocks.ts` — block detection: walks ancestors from the pointer target, scores candidates (semantic tag, text amount, size, interactivity), excludes controls and the annotator's own UI
- `src/anchors.ts` — anchor creation (selector + XPath + text quote + fingerprint) and progressive resolution: selector → XPath → exact quote → fingerprint/fuzzy (bigram similarity) → detached. Selector/XPath hits are verified against the stored quote so a stale path never silently attaches to wrong content
- `src/storage.ts` — `AnnotationStorage` adapters: memory, localStorage, IndexedDB, Tampermonkey/GM (userscript-wide → cross-site collection); JSON-document adapters share `DocumentStorage` with a `schemaVersion` and `migrateDB` hook
- `src/ui.ts` — shadow-DOM UI (hover highlight, gutter markers, composer, sidebar with plugin tabs); overlays are `position: fixed` against element rects, never in-flow
- `src/markdown.ts` — tiny renderer that HTML-escapes everything before applying markup (imported annotations can't inject markup)
- `src/plugins/portable-data.ts` — `exportJSON` / `importJSON` (skip/replace/merge/duplicate, default non-destructive skip), `exportMarkdown`, size-capped inline `#wm=` URLs
- `src/plugins/global-browser.ts` — "All pages" sidebar tab: live search across every stored annotation (AND-ed tokens over note body, anchored quote, URL and title, plus a `site:` filter), collapsible per-page groups with counts, per-page JSON export, and click-through that scrolls to same-page notes or opens another page on its `#wm-note=` link. Adapters without `listAll`/`listPages` degrade to a message
- `src/plugins/chat.ts` + `src/providers/{claude,openai}.ts` — optional AI conversation pane. The plugin adds a Chat sidebar tab and an "Ask AI" note action, assembles a structured context per scope (this page / all notes / one note, each size-capped) and always shows the user what will be sent; nothing leaves the browser until Send is pressed. Providers are pluggable (`ChatProvider`); two ship in the box — Claude (Messages API) and a generic OpenAI-compatible one whose `baseURL` also covers OpenRouter, Groq, Together and local Ollama. Both stream SSE browser-side and share `providers/sse.ts` + `providers/context-prompt.ts`. No core module imports any of them
- `src/plugins/firstmate.ts` + `bin/firstmate-drop-watch.mjs` — "Send to firstmate": hands the current page's unsent notes to a firstmate agent through a downloaded JSON file and a folder watcher, no server. See [Send to firstmate](#send-to-firstmate)
- `src/plugins/excalidraw.ts` — optional whiteboards attached to notes. Lazy-loads Excalidraw (+React) from esm.sh only when a board is first opened, so it adds no weight otherwise; stores the full editable scene as an `excalidraw` attachment (rides along in JSON export) plus a size-capped SVG preview shown on the sidebar card. Adds an "Add board"/"Open board" note action and the `note.open-board` command. A custom `loader` option can replace the CDN (e.g. for CSP-strict sites)

## Reference userscript

`scripts/webmods-annotate.user.js` is generated by `build.mjs` — edit `src/`, not the output. It stores annotations in GM storage (one cross-site collection) and adds Tampermonkey menu commands: toggle mode, toggle sidebar, export JSON/Markdown, import JSON, send to firstmate.

## Send to firstmate

Sends the current page's annotations to a firstmate agent, the way Lavish Editor sent feedback from its served page, but with no server and no port. Open the document being worked on in the browser (for a local Lavish HTML file, as a `file://` URL), annotate it, then run **Send to firstmate** from the Tampermonkey menu or the sidebar header button.

1. The action collects this page's notes that were never sent, or were edited after their last send. Archived notes are skipped.
2. It triggers a browser download of one file, `firstmate-annotate-<timestamp>.json`, where the timestamp is ISO 8601 basic format without colons (`20260928T032053.123Z`). The file lands in the browser's default download folder. Turn off "Ask where to save each file" so it lands there without a dialog.
3. After the download is handed to the browser, those note versions are recorded as sent (setting `firstmate.sent`, `{ noteId: updatedAt }`). A failed save leaves them unsent. The browser gives the page no confirmation that the file reached disk, so a download the browser later cancels still counts as sent; edit the note or clear the setting to resend.
4. The watcher turns each file into one firstmate inbox note.

For `file://` pages, Tampermonkey needs file access: in `chrome://extensions`, open Tampermonkey's details and turn on **Allow access to file URLs**. Without it the userscript does not run on local files at all.

### Watcher

```
FM_ROOT=/path/to/firstmate node annotate/bin/firstmate-drop-watch.mjs [--dir ~/Downloads] [--once] [--interval 2000]
```

- `--dir` / `FIRSTMATE_DROP_DIR`: folder to watch. Default `~/Downloads`.
- `--fm-root` / `FM_ROOT`: the firstmate checkout holding `bin/fm-inbox.sh`. Required.
- `--once`: process the files present now and exit, with status 1 if any failed. Without it, the folder is polled every `--interval` ms.

For each `firstmate-annotate-*.json` it runs `$FM_ROOT/bin/fm-inbox.sh note --request-id <sha256 of the file> -` with a Markdown rendering of the payload on stdin, then moves the file to `processed/`. The request id makes a re-run on the same file replay the original note instead of adding a second one. A file that fails to parse moves to `rejected/`. A file whose `fm-inbox.sh` call fails stays in place and is retried on the next scan. `FM_HOME` in the environment passes through to `fm-inbox.sh`.

### JSON schema

```jsonc
{
  "format": "wm-annotate-firstmate",
  "schemaVersion": 1,
  "sentAt": "2026-09-28T03:20:53.123Z",        // ISO 8601
  "page": {
    "url": "file:///Users/me/plans/plan.html", // full page URL
    "title": "Plan" | null,
    "localPath": "/Users/me/plans/plan.html" | null // decoded path, file:// pages only
  },
  "notes": [                                   // oldest first
    {
      "id": "an_...",
      "anchor": {
        "kind": "block" | "range",             // range = a text selection inside a block
        "selector": "#intro > p" | null,       // CSS selector of the block
        "quote": "the quoted text" | null,     // block text, or the selected text for a range
        "prefix": "text before" | null,
        "suffix": "text after" | null
      },
      "body": "Markdown note text",
      "createdAt": "2026-09-28T03:00:00.000Z",
      "updatedAt": "2026-09-28T03:10:00.000Z"
    }
  ]
}
```
