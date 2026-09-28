# @webmods/annotate

Framework-agnostic TypeScript library for annotating arbitrary web pages: Markdown notes attached to page blocks, robust anchors that survive DOM changes, pluggable storage, a Notion-comments-style sidebar, shareable `#wm-note=` links, and JSON export/import.

Spec: [docs/webmods-annotate-spec.md](../docs/webmods-annotate-spec.md). This implements the spec's initial recommended scope (§36): core + robust block anchors + Tampermonkey shared storage + Markdown notes + notes sidebar + note anchor links + JSON import/export + minified one-import build.

The optional AI Chat tab needs a key from either provider. Anthropic keys are workspace-scoped and the obvious Console page refuses non-admins — see [docs/ANTHROPIC-API-KEY.md](../docs/ANTHROPIC-API-KEY.md). An OpenAI (or OpenAI-compatible) key is the self-serve alternative; pick the provider in the *Configure AI chat…* menu command.

Annotate is meant to become its own product: its own repository, and probably a browser extension instead of a userscript. For now it stays here, in `annotate/`.

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
- `src/plugins/firstmate.ts` + `src/url-folder.ts` + `bin/firstmate-drop-watch.mjs` - "Send to firstmate": hands the current page's unsent notes to a firstmate agent through a JSON file saved in a sanitized per-URL folder under Downloads, and a watcher that turns each file into an inbox note. No server. See [Send to firstmate](#send-to-firstmate)
- `src/plugins/excalidraw.ts` — optional whiteboards attached to notes. Lazy-loads Excalidraw (+React) from esm.sh only when a board is first opened, so it adds no weight otherwise; stores the full editable scene as an `excalidraw` attachment (rides along in JSON export) plus a size-capped SVG preview shown on the sidebar card. Adds an "Add board"/"Open board" note action and the `note.open-board` command. A custom `loader` option can replace the CDN (e.g. for CSP-strict sites)

## Reference userscript

`scripts/webmods-annotate.user.js` is generated by `build.mjs` — edit `src/`, not the output. It stores annotations in GM storage (one cross-site collection) and adds Tampermonkey menu commands: toggle mode, toggle sidebar, export JSON/Markdown, import JSON, send to firstmate, set the firstmate folder. It runs on every `http(s)://` page and, with file access allowed, on `file://` pages.

## Send to firstmate

Annotate any page the way Lavish Editor let you annotate its served page, then hand the notes to a firstmate agent. There is no server and no port. The userscript writes a JSON file into a per-URL folder under the browser's Downloads folder, and a watcher turns each file into a firstmate inbox note.

1. Open any `http(s)://` or `file://` page and annotate it.
2. Run **Send to firstmate** from the Tampermonkey menu or the sidebar's **Firstmate** dropdown.
3. The action collects this page's notes that were never sent, or were edited after their last send. Archived notes are skipped.
4. It saves them as `Downloads/<root>/<host>/<path-slug>/firstmate-annotate-<timestamp>.json`. The timestamp is ISO 8601 basic format without colons (`20260928T032053.123Z`).
5. Once Tampermonkey reports the file written, those note versions are recorded as sent (setting `firstmate.sent`, `{ noteId: updatedAt }`). A failed or cancelled download leaves them unsent.
6. The watcher delivers the file as one firstmate note naming the per-URL folder, then moves it to `processed/` in that folder.

### Tampermonkey setup

- **Download mode: Browser API.** In the Tampermonkey dashboard's Settings tab, set Config mode to Advanced, then set Download Mode to "Browser API" and grant the downloads permission. Send refuses to run in any other mode rather than save to the wrong place.
- **Tampermonkey 5.4.6227 or later.** The script passes the file to `GM_download` as a Blob, which needs 5.4.6226+. 5.4.6226 itself turned `/` into `_`, and 5.4.6227 fixed it ([#2413](https://github.com/Tampermonkey/tampermonkey/issues/2413)).
- **`.json` downloads allowed.** `GM_download` only saves file extensions whitelisted on Tampermonkey's options page. A missing `.json` fails the send with `not_whitelisted`.
- **Allow access to file URLs** for `file://` pages: in `chrome://extensions`, open Tampermonkey's details and turn it on. Without it the userscript does not run on local files at all.

### Why the folder is under Downloads

`GM_download` can only write inside the browser's Downloads folder, so `<root>` is always relative to Downloads.

- **Tampermonkey's docs are silent.** The [`GM_download` docs](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_download) say nothing about subfolders in `name`. Checked 2026-09-28.
- **Browser API mode passes the path through.** The maintainer confirms that subfolders work only in Browser API mode ([#2324](https://github.com/Tampermonkey/tampermonkey/issues/2324): "that's the only option"; [#1311](https://github.com/Tampermonkey/tampermonkey/issues/1311)). The native mode flattens `a/b.json` into `a_b.json`.
- **Chrome defines the limit.** Browser API mode is `chrome.downloads.download`, whose [`filename`](https://developer.chrome.com/docs/extensions/reference/api/downloads) is "a file path relative to the Downloads directory ... possibly containing subdirectories. Absolute paths, empty paths, and paths containing back-references `..` will cause an error."
- **Not every browser allows it.** Brave blocks subfolders even in Browser API mode (#1311). Chrome and Edge allow them.

### Folders

The root is set with **Set firstmate folder…** (menu) or **Firstmate > Folder…** (sidebar). The default is `firstmate-annotate`. It is a relative path of `a-z 0-9 . _ -` segments joined by `/`, at most 40 characters. `.`, `..` and absolute paths are refused.

Each send writes two files:

- `Downloads/firstmate-annotate.config.json`, overwritten, `{ "format": "wm-annotate-firstmate-config", "root": "<root>" }`. This is the shared config: the userscript owns the value, and the watcher reads it on every scan, so changing the folder in the browser moves the watcher too.
- The payload, in the per-URL folder below.

The per-URL folder is `<root>/<host>/<path-slug>`:

- **host:** the lowercase hostname, with `-<port>` when a port is given. Punycode stays as-is (`xn--bcher-kva.example`). `file://` pages use `file`. Credentials and the fragment are dropped.
- **path-slug:** the decoded path, lowercased, with each run of characters outside `[a-z0-9._-]` turned into one `-`, and leading and trailing `.`/`-` stripped. An empty path is `index`. The stripping is what makes `.` and `..` impossible as segments.
- **hash suffix:** a slug gets `-<8-char hash>` of the raw path and query whenever it shows less than the URL carries. That covers a query string, non-ASCII characters in the path, or a slug cut to its 64-character cap. Hosts are capped at 48 characters, and so are IPv6 literals. So `?q=one` and `?q=two` never share a folder, and the whole folder stays within 154 characters.

The rules live in `src/url-folder.ts`.

### Local docs (Lavish-style pages)

A plain HTML page can live inside the root, for example `Downloads/firstmate-annotate/docs/plan/doc.html`. The agent creates and edits that file directly, and the captain opens it as `file:///…/doc.html` and annotates it.

- **Notes land next to the doc.** For a `file://` page inside `<root>`, the send goes to the doc's own folder (`firstmate-annotate/docs/plan/`) rather than `file/<slug>`.
- **The note names the file to edit.** The payload's `page.localPath` carries the doc's absolute path.
- **Fallback:** a doc outside the root, directly in the root, or under a folder whose name is not already clean (for example `My Plan/`) falls back to `<root>/file/<path-slug>`.

### Watcher

```
FM_ROOT=/path/to/firstmate node annotate/bin/firstmate-drop-watch.mjs [--downloads ~/Downloads] [--root <rel>] [--once] [--interval 2000]
```

- `--downloads` / `FIRSTMATE_DOWNLOADS`: the browser's Downloads folder. Default `~/Downloads`.
- `--root` / `FIRSTMATE_ROOT`: overrides the root. Without it, the root comes from `firstmate-annotate.config.json`, falling back to `firstmate-annotate`. The watcher applies the same validation as the userscript.
- `--fm-root` / `FM_ROOT`: the firstmate checkout holding `bin/fm-inbox.sh`. Required.
- `--once`: process the files present now and exit. Status 1 means a file failed. Status 2 means a setup error. Without `--once`, the tree is rescanned every `--interval` ms.

The watcher scans `<downloads>/<root>` recursively, up to 8 levels deep, and skips `processed/` and `rejected/` folders. For each `firstmate-annotate-*.json` it runs `$FM_ROOT/bin/fm-inbox.sh note --request-id <sha256 of the file> -` with a Markdown rendering of the payload on stdin. The rendering names the page, the document path, and the per-URL folder.

- **Success:** the file moves to `processed/` inside its own per-URL folder, so the history stays beside the doc.
- **Replay:** the request id makes a re-run on the same file replay the original note instead of adding a second one.
- **Unparseable file:** it moves to `rejected/` in the same folder.
- **Failed `fm-inbox.sh` call:** the file stays in place and is retried on the next scan.
- **Environment:** `FM_HOME` passes through to `fm-inbox.sh`.

### JSON schema

```jsonc
{
  "format": "wm-annotate-firstmate",
  "schemaVersion": 1,
  "sentAt": "2026-09-28T03:20:53.123Z",        // ISO 8601
  "folder": "firstmate-annotate/example.com/guide-intro.html", // saved-to folder, relative to Downloads
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
