# Implementation plans — read this first

This folder contains implementation plans for the next features of `@webmods/annotate`.
Each plan is written to be executed **one file at a time, in order**, by an implementer
who follows instructions exactly. Do not skip ahead; later plans assume earlier ones landed.

Recommended order:

| # | Plan | Status | Why this order |
|---|------|--------|----------------|
| 1 | [01-robustness-pass.md](01-robustness-pass.md) | ✅ shipped (`b51fb00`) | Hardens anchors/SPA/a11y that every later feature relies on |
| 2 | [02-text-range-annotations.md](02-text-range-annotations.md) | ✅ shipped (`0116427`) | Touches core anchoring; do before adding more UI on top |
| 3 | [03-ai-chat-pane.md](03-ai-chat-pane.md) | ✅ shipped (`955b011`) | Pure plugin; needs the settings helper added in plan 01 |
| 4 | [04-global-annotation-browser.md](04-global-annotation-browser.md) | ✅ shipped (`035546e`) | Pure plugin; benefits from range + detached work |
| 5 | [05-backlog.md](05-backlog.md) | open | Smaller independent items, pick any after 1–4 |

Plans 1–4 are implemented; read them as the record of what was built and why.
Deviations worth knowing: range anchoring lives in `src/ranges.ts` (not inside
`anchors.ts`) with `normalizeText`/`textSimilarity` extracted to
`src/text-utils.ts` to avoid an import cycle, and `download`/`copyText` were
extracted to `src/dom-utils.ts` while doing plan 04. Plan 05 is the live backlog.

## Non-negotiable ground rules

1. **The spec is law.** `docs/webmods-annotate-spec.md` (repo root) overrides these plans if they conflict. Especially §34 Design Principles: small core, AI/Excalidraw are plugins, JSON canonical, never silently attach a note to wrong content, no backend required, optional features must not bloat the default bundle.
2. **Never edit generated files.** `scripts/webmods-annotate.user.js` and everything in `annotate/dist/` are build outputs. Edit `annotate/src/`, then run `node build.mjs` from `annotate/`.
3. **Every task ends with all four gates green** (run from `annotate/`):
   ```
   npx tsc --noEmit        # typecheck, zero errors
   npx vitest run          # all unit tests pass (write new ones per plan)
   node build.mjs          # build succeeds
   # headless verification — see "Headless verify harness" below
   ```
4. **Do not add runtime dependencies to the core bundle.** Heavy things load lazily from CDN (see how `src/plugins/excalidraw.ts` does it) or live behind a plugin. `devDependencies` are fine.
5. **Do not change the storage schema without a migration.** If you touch `AnnotationDB` or `Annotation`, bump `SCHEMA_VERSION` in `src/types.ts` and add a migration step in `migrateDB()` (`src/storage.ts`) plus a unit test proving old data still loads.
6. **All rendered user/imported content goes through `renderMarkdown()`** (`src/markdown.ts`) or `textContent`. Never `innerHTML` raw strings. SVG previews render only via `<img src="data:...">`.
7. **All injected UI carries the `data-wm-annotate-ui` attribute** (`UI_ATTR` from `src/blocks.ts`) so it is never itself annotatable, and is removed on `destroy()`.
8. **Commit style:** `feat(annotate): <what>` / `fix(annotate): <what>`, body explains why, ends with the Claude co-author line used in `git log`.

## Current architecture (as of commit `bba275c`)

```
annotate/src/
├── types.ts        # all public interfaces, SCHEMA_VERSION, fragment param names
├── annotator.ts    # createAnnotator(): modes, events, note CRUD, #wm-note= nav,
│                   #   SPA hooks (popstate + pushState patch), plugins, commands
├── blocks.ts       # block detection/scoring, UI_ATTR, exclusions
├── anchors.ts      # createAnchor(), resolveAnchor() (selector→xpath→quote→fuzzy→detached),
│                   #   textSimilarity() (bigram dice), buildSelector(), buildXPath()
├── page-identity.ts# normalizeUrl(), stripOwnFragment(), hashString(), default resolver
├── storage.ts      # AnnotationStorage adapters; DocumentStorage wraps JSON-doc backends
│                   #   (memory/localStorage/GM); IndexedDB is separate; migrateDB()
├── markdown.ts     # tiny sanitizing renderer (escapes BEFORE marking up)
├── commands.ts     # command registry
├── events.ts       # Emitter + generateId()
├── ui.ts           # AnnotatorUI class: shadow root, hover box, gutter markers,
│                   #   composer, sidebar (tabs + note cards + note actions), focusNote()
├── userscript.ts   # thin Tampermonkey host (menu commands, plugins wired)
└── plugins/
    ├── portable-data.ts  # exportJSON/importJSON/exportMarkdown/createInlineURL
    └── excalidraw.ts     # lazy CDN whiteboards; the reference for "lazy plugin" pattern
```

Key extension points a plugin gets via `PluginContext` (`src/types.ts`):
`on(event, handler)`, `addSidebarTab(tab)`, `addNoteAction(action)`, `commands`,
`storage`, `getPage()`, `getNotes()`, `scrollToNote(id)`, `annotator` (full API).

Facts that will bite you if forgotten:

- **The UI lives in a closed world:** one host `<div data-wm-annotate-ui>` on
  `document.documentElement` with a shadow root. Sidebar/composer/markers are inside it.
  The Excalidraw modal is the one exception (light DOM, still flagged with `UI_ATTR`)
  because Excalidraw injects global CSS.
- **esbuild must not see CDN imports.** Use the `dynamicImport = new Function("u", "return import(u)")`
  trick from `src/plugins/excalidraw.ts` for any runtime `import()` of a URL.
- **jsdom quirks in tests:** no layout (fake `getBoundingClientRect` like `test/blocks.test.ts`),
  no `localStorage` (shimmed in `test/setup.ts`), no `scrollIntoView` (guard with `?.`).
- **DocumentStorage clones on read/write** (memory adapter) — callers can't mutate the store
  through returned references. Keep that property.
- **`resolveAnchor` verifies selector/xpath hits against the stored text quote.** Never
  add a resolution path that returns an element without a confidence check.

## Headless verify harness

Unit tests can't see layout, CSS, or real CDN loads, so every UI-facing plan includes a
headless Chrome script. Pattern (see `git log` for examples that were used):

1. Write `verify-<feature>.mjs` using puppeteer. Load the userscript bundle by reading
   `annotate/dist/annotate.user.js`, stripping the `// ==UserScript==` header block, and
   `page.evaluate(script)` on a local test page (`file://` HTML fixture you write).
   The annotator instance is exposed as `window.__wmAnnotate`.
2. Puppeteer is installed in `skills/greasyfork/scripts/node_modules`. ESM resolves
   imports relative to the **script file**, so copy your `.mjs` into
   `skills/greasyfork/scripts/`, run it there, delete it after.
3. Interact through the shadow root:
   `document.querySelector("[data-wm-annotate-ui]").shadowRoot.querySelector(...)`.
4. Print `PASS`/`FAIL` per check, exit non-zero on any failure, and take a screenshot
   of any new UI. **Look at the screenshot** — layout bugs pass DOM checks.

## Definition of done (every plan)

- [ ] All four gates green (typecheck, unit tests, build, headless verify)
- [ ] New public API exported from `src/index.ts`
- [ ] `annotate/README.md` architecture section updated (one bullet per new module)
- [ ] No `console.log` left behind (only `console.error`/`console.warn` with the
      `[webmods-annotate]` prefix)
- [ ] Spec cross-checked: the plan's "Acceptance criteria" all demonstrably true
