# Plan 05 — Backlog: smaller independent items

Each item here is self-contained and can be done in any order after plans 01–04.
Sized S/M/L. Follow the same ground rules as always (00-OVERVIEW.md).

---

## 5.1 Consume inline share URLs (`#wm=`) on load — M

`createInlineURL()` exists (portable-data plugin) but nothing reads `#wm=` payloads
on page load, so inline links are currently write-only. Close the loop.

- In `src/plugins/portable-data.ts` `setup()`: check
  `parseInlineFragment(location.hash)`. If it yields `{ page, annotation }` and the
  annotation is NOT already in storage:
  - Show a confirmation bar (spec §19: "do not automatically execute embedded
    content" — import must be user-confirmed). Render it via a new
    `PluginContext.showNotice(text, actions: {label, onClick}[]): () => void`
    (implement in ui.ts as a fixed top-center bar inside the shadow root,
    `role="status"`).
  - Text: `This link contains an annotation ("<first 60 chars>…"). Import it?`
    Actions: `Import` → `storage.save(annotation, page)` + `refresh()` +
    `focusNote(id)`; `Dismiss` → remove bar.
- Validation already exists (`validateAnnotation` inside `parseInlineFragment`).
  Extra guard: reject if `annotation.body.text.length > 10_000` or attachments
  present with `scene` larger than 50 kB serialized (inline URLs must stay small).
- Add a `Copy inline link` entry: extend the note-card Copy link button into a
  small menu? NO — keep simple: add a second note action via the plugin:
  `{ id: "copy-inline-link", label: "Copy portable link", onClick }` that calls
  `createInlineURL` and copies (reuse the GM_setClipboard/clipboard fallback —
  extract `copyText()` helper from annotator.ts `copyNoteLink` into `dom-utils.ts`).
  If the annotation exceeds the size cap, `showNotice("Too large for a portable link")`.
- Tests: fragment with valid payload → notice appears (unit: assert callback
  registration), Import stores + renders; oversized/corrupt payload → no notice,
  no throw; existing id → no notice. Headless: open fixture with a generated `#wm=`
  URL, click Import, note appears; screenshot the notice bar.

## 5.2 Ship as a companion Chrome extension — M

Repo already generates extensions from userscripts (`tools/build-extensions.mjs`,
docs/EXTENSIONS.md). Follow that doc precisely; summary:

- Create `extensions/webmods-annotate/source.json` naming
  `scripts/webmods-annotate.user.js`, plus a hand-written `manifest.json`
  (MV3, content script matching `<all_urls>`, default isolated world is fine —
  the script needs no page globals; DO NOT set `world: "MAIN"`).
- The generator maps `GM_*` grants to shims — verify it supports
  `GM_getValue/GM_setValue/GM_registerMenuCommand/GM_setClipboard`; menu commands
  have no Tampermonkey menu in an extension, so the shim must surface them
  somewhere (check how existing extensions in `extensions/` handle it; if there is
  no pattern, expose them via the extension's action popup listing the commands).
- Storage: GM shim should back onto `chrome.storage.local` so the cross-site
  collection property is preserved (userscript-wide ≙ extension-wide).
- Icons: `tools/make-icons.mjs` exists for generating sizes.
- MUST verify headlessly per docs/EXTENSION-TESTING.md (puppeteer
  `--load-extension`); "works as a userscript" is explicitly not evidence.

## 5.3 CSP-proof Excalidraw loading — M

On CSP-strict sites (github.com) the esm.sh import is blocked. Provide a loader that
routes through `GM_xmlhttpRequest` (userscript CSP bypass):

- New export in `src/plugins/excalidraw.ts`:
  `createGMLoader(versions?): ExcalidrawLoader` — fetches the ESM bundles as text via
  `GM_xmlhttpRequest`, rewrites their relative imports? **Stop** — rewriting ESM
  graphs is a rabbit hole. Instead fetch esm.sh's `?bundle` variants
  (self-contained single files: `https://esm.sh/react@<v>?bundle`, etc.), create
  `blob:` URLs, and `dynamicImport(blobUrl)`. `blob:` is allowed under most CSPs'
  `script-src` only if `blob:` is listed — if the import throws, fall back to a
  clear error notice ("This site's CSP blocks the whiteboard").
- Userscript host: try the default loader, catch, retry with `createGMLoader()`
  when `GM_xmlhttpRequest` exists. Add `@grant GM_xmlhttpRequest` +
  `@connect esm.sh` to the header in `build.mjs`.
- Verify on a real CSP page headlessly by serving a fixture with a strict
  `Content-Security-Policy` header (needs the node http server, see plan 04's note).
  Accept partial success: if blob is also blocked, assert the error notice shows.

## 5.4 Publish to Greasy Fork — S

When the user asks for a release (do not do this unprompted):

- Add an entry for `scripts/webmods-annotate.user.js` to `greasyfork.json`
  (mirror existing entries; `visibility: "public"`, blurb from the `@description`).
- Follow `docs/PUBLISHING.md` + the `greasyfork` skill exactly. Remember (repo
  CLAUDE.md): pushing does NOT release — run
  `node skills/greasyfork/scripts/release.mjs` after push and confirm with
  `verify.mjs`.
- `@version` is date-based and set by `build.mjs` at build time — rebuild on the
  release day so the version matches.

## 5.5 Note timestamps + sort in the sidebar — S

- Note cards show `updatedAt` as a muted `YYYY-MM-DD HH:mm` line (locale-agnostic,
  pad manually — `Date.now()` formatting only, no Intl dependency assumptions).
- Sidebar note order: document order of resolved targets (compare
  `compareDocumentPosition`), detached notes last, newest first among detached.
  Currently order is storage order — implement in `AnnotatorUI.renderNotes` by
  sorting the `notes` array before storing it (do NOT mutate the caller's array).
- Unit tests for the sort (fake rects not needed; compareDocumentPosition works in
  jsdom). Update any test that assumed storage order.

## 5.6 Marker overlap declutter — S

Two notes on adjacent lines produce overlapping gutter markers.

- In `repositionMarkers`, after computing positions, walk markers sorted by `top`;
  when a marker's box (22px) intersects the previous one's, shift it down to
  `prevTop + 24`. Purely visual; no state.
- Headless verify with two notes on consecutive `<li>`s; screenshot.

## 5.7 `refresh()` on tab visibility — S

SPAs and background tabs: when `document.visibilitychange` → visible AND the page
identity changed while hidden, call `refresh()`. Listener registered in
`createAnnotator`, disposed in `destroy()`. Unit test with a synthetic event
(jsdom lets you dispatch `visibilitychange` after redefining
`document.visibilityState` via `Object.defineProperty`).
