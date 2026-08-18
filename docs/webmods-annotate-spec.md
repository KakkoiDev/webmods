# Webmods Annotate — Project Specification

## 1. Project Summary

**Webmods Annotate** is a small, framework-agnostic TypeScript library for annotating arbitrary web pages.

It is designed primarily for use from Tampermonkey/Webmods, but the core must remain portable enough to run in:

- Tampermonkey/userscripts
- ordinary JavaScript applications
- browser extensions
- Webmods
- embedded developer/review tooling

The library provides annotation mechanics and extension points. Persistence, AI integration, drawing, export, and other larger features should be implemented through adapters/plugins wherever practical.

### Core goals

1. Enter and leave annotation mode through a simple API/callback.
2. Detect meaningful page blocks and highlight the active block on hover.
3. Attach Markdown notes to blocks.
4. Reliably relocate annotations when revisiting a page.
5. Show all annotations for the current page in a Notion-comments-style side pane.
6. Allow persistence to be replaced without changing annotation logic.
7. Store annotations from many websites in one userscript/browser-side collection when the host permits it.
8. Export/import annotation data.
9. Support optional Excalidraw attachments.
10. Support an optional AI conversation pane, initially suitable for Claude-style workflows.
11. Generate links that navigate directly to annotated locations.
12. Ship as TypeScript plus a dependency-light minified browser build that can be included with one script/import.

---

## 2. Non-goals for the Core

The core should NOT:

- depend on Claude, OpenAI, or another AI provider;
- require a backend server;
- require a framework such as React/Vue/Svelte;
- require Excalidraw to load for ordinary text annotations;
- assume a particular persistence mechanism;
- mutate the host page more than necessary;
- permanently rewrite host-page HTML to create anchors;
- rely exclusively on brittle CSS selectors.

---

## 3. Package Architecture

```text
@webmods/annotate
│
├── core
│   ├── lifecycle
│   ├── annotate/explore mode
│   ├── block detection
│   ├── hover/highlight
│   ├── anchor creation
│   ├── anchor resolution
│   ├── note CRUD
│   └── events/hooks
│
├── ui
│   ├── annotation composer
│   ├── note marker/highlight
│   ├── notes sidebar
│   └── plugin sidebar slots
│
├── storage
│   ├── memory
│   ├── localStorage
│   ├── IndexedDB
│   ├── Tampermonkey/GM
│   └── custom adapter interface
│
└── plugins
    ├── portable-data
    ├── excalidraw
    ├── chat/AI
    └── sharing
```

Core and UI may be published together initially, but internal boundaries should make later package splitting possible.

---

## 4. Distribution

Required builds:

```text
dist/
├── annotate.js
├── annotate.min.js
├── annotate.esm.js
└── annotate.user.js
```

### ESM

```ts
import { createAnnotator } from "@webmods/annotate";
```

### Browser/global build

```html
<script src=".../annotate.min.js"></script>
<script>
  const annotator = WebmodsAnnotate.create();
</script>
```

### Tampermonkey/Webmods

The minified build should be usable with one `@require`/import link. Ordinary annotation functionality should have no mandatory large runtime dependencies.

Excalidraw and AI integrations should be lazy-loaded or separate plugins.

---

## 5. Modes

The annotator has at minimum two modes.

### Explore mode

Default state.

- Page behaves normally.
- Links, buttons, forms, selection, scrolling, etc. continue working.
- Existing annotation indicators may remain visible depending on configuration.

### Annotate mode

- Pointer movement identifies an annotatable block.
- Candidate block receives a temporary hover highlight.
- Clicking the candidate creates/opens an annotation composer.
- Host application can provide its own activation control.

Core API:

```ts
interface Annotator {
  enter(): void;
  exit(): void;
  toggle(): void;
  destroy(): void;
  getMode(): "explore" | "annotate";
}
```

Mode changes must emit events/hooks.

---

## 6. Block Detection

Do not treat every DOM node as an annotation target.

Candidate semantic elements include:

- `article`
- `section`
- `p`
- `li`
- `blockquote`
- `pre`
- `figure`
- `table`
- `h1`–`h6`
- meaningful semantic containers
- sufficiently meaningful `div` containers

The resolver begins from `event.target`, walks ancestors, scores candidates, and selects the most useful annotation block.

### Candidate scoring factors

Consider:

- visible text/content amount;
- element dimensions;
- semantic tag;
- nesting depth;
- whether a smaller semantic child is preferable;
- interactive status;
- visibility;
- generated/overlay/navigation content;
- configured exclusions.

### Exclusions

By default avoid capturing controls such as:

- `input`
- `textarea`
- `select`
- buttons when annotation would interfere with their action
- draggable/interactive widgets
- annotation UI itself

Allow custom block resolvers and exclusion rules.

```ts
createAnnotator({
  blockResolver,
  exclude,
});
```

---

## 7. Annotation Data Model

Canonical data should be serializable JSON.

```ts
interface Annotation {
  id: string;
  pageId: string;
  createdAt: number;
  updatedAt: number;

  anchor: Anchor;

  body: {
    type: "markdown";
    text: string;
  };

  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}
```

IDs should be globally unique enough to support merging/export/import and future remote synchronization (UUID/ULID-style identifiers are acceptable).

---

## 8. Page Identity

Annotations must be grouped by a normalized page identity rather than blindly using the exact browser URL.

```ts
interface PageIdentity {
  id: string;
  url: string;
  normalizedUrl: string;
  title?: string;
}
```

Default URL normalization should normally:

- remove the annotation library's own fragment parameters;
- allow configurable removal of tracking query parameters;
- preserve query parameters that materially identify content;
- avoid treating ordinary `#wm-note=...` navigation as a different page.

Applications must be able to override page identity for SPAs or domain-specific behavior.

---

## 9. Robust Anchoring

Anchoring is a critical subsystem.

Never depend only on a generated CSS selector.

```ts
interface Anchor {
  url: string;
  selector?: string;
  xpath?: string;

  textQuote?: {
    exact: string;
    prefix?: string;
    suffix?: string;
  };

  textPosition?: {
    start: number;
    end: number;
  };

  fingerprint?: {
    tag: string;
    text?: string;
    nearbyHeading?: string;
    attributes?: Record<string, string>;
  };
}
```

Initial release may support block annotations only, but the schema should permit later text-range annotations.

### Resolution strategy

Attempt progressively:

1. exact selector/known DOM path;
2. exact text quote;
3. structural fingerprint;
4. nearby heading/context;
5. fuzzy nearby-text recovery;
6. mark annotation as detached if confidence is insufficient.

Do not silently attach a note to an unrelated element when confidence is low.

Resolution should expose confidence/status to callers.

```ts
type AnchorResolution =
  | { status: "resolved"; element: Element; confidence: number }
  | { status: "detached"; reason?: string };
```

---

## 10. Notes

V1 note body format: Markdown.

Basic operations:

```ts
createNote(anchor, body)
updateNote(id, patch)
deleteNote(id)
getNote(id)
getPageNotes(page)
scrollToNote(id)
```

The default composer should remain deliberately small.

Required actions:

- write/edit Markdown;
- save;
- cancel;
- delete existing note;
- open attachments when plugins provide them.

---

## 11. Event / Callback API

The host must be able to observe or replace important behavior.

Suggested hooks:

```ts
createAnnotator({
  onModeChange,
  onBlockHover,
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
  onSaveNote,
  onNavigateToNote,
  onAnchorDetached,
  onError,
});
```

Also consider a generic event API:

```ts
annotator.on("note:create", handler);
annotator.on("note:save", handler);
annotator.on("mode:change", handler);
```

Avoid coupling core behavior to callbacks when a storage adapter/event is sufficient.

---

## 12. Storage Adapter

Persistence must be abstract.

```ts
interface AnnotationStorage {
  getPage(page: PageIdentity): Promise<Annotation[]>;
  get(id: string): Promise<Annotation | null>;
  save(annotation: Annotation): Promise<void>;
  delete(id: string): Promise<void>;
  listPages?(): Promise<PageSummary[]>;
  listAll?(): Promise<Annotation[]>;
}
```

Built-in adapters:

1. `MemoryStorage`
2. `LocalStorageStorage`
3. `IndexedDBStorage`
4. `TampermonkeyStorage`
5. custom adapter

Example custom DB:

```ts
const annotator = createAnnotator({
  storage: {
    getPage,
    get,
    save: saveToDatabase,
    delete: deleteFromDatabase,
  },
});
```

### Cross-site storage

The Tampermonkey/userscript adapter should store data in userscript-wide storage so annotations from different origins can live in one logical collection.

Ordinary page `localStorage` remains origin-scoped and therefore should NOT be the recommended Tampermonkey default.

IndexedDB is suitable for larger local data, but origin/storage context must be considered by the host environment.

The storage abstraction must hide these differences from core.

---

## 13. Suggested Logical Database Structure

```text
annotation-db
│
├── pages
│   ├── <page-id>
│   │   ├── identity
│   │   └── annotations
│   └── ...
│
├── attachments
│   └── ...
│
├── settings
│
└── schemaVersion
```

A schema version is required from the beginning to permit migrations.

---

## 14. Notes Sidebar

Provide a side pane similar in spirit to document comments.

Required behavior:

- open/close without permanently altering site layout;
- list current-page notes;
- show note excerpt and target context;
- click note → scroll to annotation;
- temporarily emphasize target after navigation;
- edit/delete note;
- indicate detached notes;
- show attachment indicator;
- plugin-defined tabs/panels.

Concept:

```text
┌──────────────────────────────┬──────────────────────┐
│                              │ Notes | Chat         │
│        Host page             │                      │
│                              │ 3 notes              │
│   ┌──────────────────────┐   │                      │
│   │ highlighted block    │◄──│ Authentication...   │
│   └──────────────────────┘   │ Rewrite this...     │
│                              │ [drawing] Flow...    │
│                              │                      │
└──────────────────────────────┴──────────────────────┘
```

Prefer Shadow DOM or similarly strong style isolation so host CSS does not break the annotation UI and annotation styles do not leak into the host page.

---

## 15. Global Annotation Browser

The storage API should make a future/global view possible even if this is not required for the first UI milestone.

Example:

```text
All annotations

Search: authentication

example.com/article      3 notes
github.com/project       5 notes
docs.example.dev         2 notes
```

Capabilities may later include:

- full-text note search;
- URL/domain filtering;
- tags;
- detached annotation repair;
- export selected pages;
- open original page and navigate to note.

Do not make V1 core dependent on this UI.

---

## 16. Attachments

Attachments must be extensible.

```ts
type Attachment =
  | ExcalidrawAttachment
  | ImageAttachment
  | CustomAttachment;
```

Plugins should be able to register attachment renderers/editors.

Large binary/scene data may be stored separately from the annotation record and referenced by ID.

---

## 17. Excalidraw Plugin

Optional plugin.

Purpose: attach editable diagrams/whiteboards to an annotation when text alone is insufficient.

```ts
annotator.use(createExcalidrawPlugin());
```

Example attachment:

```ts
interface ExcalidrawAttachment {
  id: string;
  type: "excalidraw";
  scene: unknown;
  preview?: string;
}
```

Requirements:

- lazy-load Excalidraw;
- create canvas from a note;
- reopen/edit existing canvas;
- persist complete editable scene data;
- optionally generate/store lightweight preview;
- include scene in JSON export;
- reference it sensibly in Markdown export;
- do not add Excalidraw weight to users who never use it.

---

## 18. AI / Conversation Plugin

AI is optional and must not be built into core.

```ts
annotator.use(
  createChatPlugin({
    provider: claudeProvider,
  })
);
```

Provider abstraction:

```ts
interface ChatProvider {
  send(request: ChatRequest): AsyncIterable<ChatChunk> | Promise<ChatResponse>;
}
```

Potential providers:

- Claude
- OpenAI
- local model
- Webmods agent
- custom HTTP/backend provider

### Context actions

The UI should be capable of:

- Ask about page
- Ask about selected/annotated block
- Ask about this note
- Ask about all page annotations

Structured context example:

```ts
interface AnnotationChatContext {
  page: PageIdentity;
  annotation?: Annotation;
  targetText?: string;
  targetHTML?: string;
  surroundingText?: string;
  pageAnnotations?: Annotation[];
}
```

The provider decides how this context becomes a model prompt.

Do not hard-code provider prompt formats into core.

---

## 19. Sharing and Annotation URLs

Annotations should have navigable links.

### Local anchor link

Example:

```text
https://example.com/article#wm-note=<annotation-id>
```

On initialization:

1. detect annotation fragment;
2. locate note in configured storage;
3. resolve its anchor;
4. scroll target into view;
5. temporarily highlight target;
6. open/focus note.

This link only works for another browser/user if that annotation data is also available there.

### Inline portable link

For sufficiently small annotations, optionally encode portable data into the URL fragment.

Concept:

```text
https://example.com/article#wm=<compressed-data>
```

Requirements:

- version the encoded format;
- compress where useful;
- validate before import;
- enforce maximum size;
- never assume large Excalidraw scenes fit safely in a URL;
- do not automatically execute embedded content.

### Remote share strategy

Allow a future adapter to produce remote links:

```ts
share(annotation, {
  strategy: "anchor" | "inline" | "remote",
});
```

Core must not require a remote Webmods service.

---

## 20. Portable Data Plugin

JSON is the canonical portable representation.

Plugin capabilities:

```ts
exportJSON(opts?)
importJSON(data)
exportMarkdown(opts?)
downloadExport(format, opts?)
createInlineURL(annotation)
```

Export scope, via `opts.scope`:

```text
"page"  only the current page
"site"  every stored page on the current host
"all"   everything stored (default)
```

The notes sidebar carries one-click MD and JSON buttons in its header. Their
scope follows the visible tab: "site" on Notes, "all" on All pages.

### JSON export

Must preserve enough information for lossless restoration:

- schema version;
- page identities;
- annotations;
- anchors;
- timestamps;
- metadata;
- attachments;
- attachment references/data;
- relevant plugin data.

### Import

Import is mandatory alongside export.

Support collision strategy such as:

```ts
"skip" | "replace" | "merge" | "duplicate"
```

Default should avoid destructive replacement.

### Markdown export

Human-readable representation example:

```md
# example.com/article

Source: https://example.com/article

## Authentication

> Context excerpt from the annotated block...

This section needs clarification.

## Database architecture

The cache appears unnecessary.

Attachment: database-flow.excalidraw
```

Markdown is a projection, not the canonical backup format.

---

## 21. Plugin System

Keep the plugin API deliberately small.

Concept:

```ts
interface AnnotatorPlugin {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

annotator.use(plugin);
```

Possible plugin capabilities exposed through `PluginContext`:

- subscribe to annotation events;
- add sidebar tab;
- register attachment type;
- register export format;
- register command/action;
- access storage through controlled API;
- request navigation/highlighting;
- add toolbar/composer action.

Before implementation, align lifecycle/naming with the existing Webmods plugin conventions where possible rather than inventing a conflicting plugin model.

---

## 22. UI Isolation

The library runs on arbitrary pages and must expect hostile/unusual CSS.

Preferred approach:

- mount library UI into a Shadow Root;
- use minimal fixed overlay roots;
- use very high but configurable z-index;
- avoid modifying host styles;
- remove all injected UI/listeners on `destroy()`;
- ensure annotation overlays use `pointer-events` carefully;
- preserve page scrolling and accessibility.

---

## 23. SPA / Dynamic Page Support

Modern pages can change without navigation.

The library should support:

- History API navigation;
- `popstate`;
- DOM changes after load;
- delayed/lazy-rendered targets;
- re-resolving annotations after route changes.

Use MutationObserver sparingly; avoid continuously rescanning the entire DOM.

Expose a manual method:

```ts
annotator.refresh();
```

Hosts should also be able to supply page identity/navigation hooks.

---

## 24. Performance Requirements

Annotation mode must remain lightweight on large pages.

Guidelines:

- event delegation rather than listeners on every block;
- resolve hover target on demand;
- no permanent full-page DOM scan unless required;
- debounce expensive anchor/fuzzy operations;
- lazy-load optional plugins;
- cache resolved annotation anchors where safe;
- clean caches after page/route changes.

Target: ordinary browsing should feel unchanged while annotation mode is disabled.

---

## 25. Security / Privacy

Annotations can contain private information.

Requirements:

- local storage by default;
- no network requests from core;
- AI plugin sends data only after explicit user action/configuration;
- clearly define what page context is sent to an AI provider;
- sanitize rendered Markdown/HTML;
- never execute imported annotation content;
- validate imported JSON;
- version portable formats;
- remote storage adapters own authentication concerns;
- avoid storing secrets in share URLs.

---

## 26. Accessibility

Required baseline:

- keyboard-accessible annotation UI;
- visible focus states;
- proper ARIA roles/labels;
- sidebar usable without mouse;
- Escape closes temporary editor/interaction where appropriate;
- configurable annotation-mode keyboard shortcut;
- hover-only information must have keyboard equivalent.

---

## 27. Suggested Public API

Illustrative, not final:

```ts
import {
  createAnnotator,
  createIndexedDBStorage,
  createTampermonkeyStorage,
  createPortableDataPlugin,
} from "@webmods/annotate";

const annotator = createAnnotator({
  storage: createTampermonkeyStorage(),

  onModeChange(mode) {
    console.log(mode);
  },

  onSaveNote(note) {
    console.log(note);
  },
});

annotator.use(createPortableDataPlugin());

annotator.enter();
```

Custom backend:

```ts
const annotator = createAnnotator({
  storage: myDatabaseStorage,
});
```

The API should remain usable without any UI plugin for hosts that want to build their own interface.

---

## 28. Tampermonkey Host

The first reference host should demonstrate the smallest useful integration.

Responsibilities:

- load minified library;
- initialize Tampermonkey storage adapter;
- provide activation shortcut/menu command;
- initialize default notes sidebar;
- optionally initialize export plugin;
- work across configured websites.

The Tampermonkey host should contain very little annotation logic itself.

Conceptually:

```js
const annotations = WebmodsAnnotate.create({
  storage: WebmodsAnnotate.tampermonkeyStorage(),
});

annotations.registerDefaultUI();
annotations.registerShortcut();
```

Exact naming should follow final Webmods conventions.

---

## 29. Configuration

Possible configuration shape:

```ts
interface AnnotatorOptions {
  storage?: AnnotationStorage;
  pageIdentity?: PageIdentityResolver;
  blockResolver?: BlockResolver;

  ui?: {
    sidebar?: boolean;
    position?: "left" | "right";
    showMarkers?: boolean;
    cornerWidget?: boolean;
  };

  anchors?: {
    fuzzyMatching?: boolean;
  };

  shortcuts?: {
    toggle?: string;
  };

  exclude?: string[] | ((element: Element) => boolean);
}
```

Defaults should make this work:

```ts
const annotator = createAnnotator();
```

---

## 29b. Archived notes

Archiving keeps a note but takes it out of the way.

- state lives in `metadata.archived` as a timestamp, so no schema change;
- archived notes get no marker, no range highlight, and no anchor resolution;
- they leave the page note count and sit behind an `Archived (n)` disclosure
  in the Notes tab, each offering Restore and Delete;
- JSON export keeps them with the flag, so backup and restore never drops or
  silently revives notes; Markdown export moves them to a trailing
  `# Archived` section;
- the All pages tab still lists them, labelled `archived`, so a note archived
  on a page you never revisit stays reachable.

---

## 29b-bis. Grouping the All pages list by site

A `Group by site` switch above the list gathers page cards under one section per
host.

- grouping is by host, not by registrable domain: without a public suffix list,
  trimming labels would merge unrelated sites (two `github.io` pages) and split
  real ones;
- each section header carries the host, its note and page totals, an
  `Export site` button, and collapses to hide its pages;
- `Export site` writes `webmods-annotations-<host>.json` holding every stored
  page of that host, ignoring the search filter, the same way the per-page
  `Export` takes the whole page: an export that quietly omits notes is a
  broken backup;
- a grouped page card drops its host suffix, which the section header carries;
- the choice lives in the plugin, so switching sidebar tabs keeps it, and a
  page reload starts ungrouped.

---

## 29c. Corner widget

A small panel in the bottom-right corner, revealed by the pointer resting in a
22x22 hotspot for 250ms and hidden 400ms after it leaves.

- an `Annotate mode` switch mirroring the annotate mode shortcut both ways;
- a button that toggles the notes sidebar;
- lives in the annotator's own shadow layer, so it is never annotatable;
- hides while a fullscreen element is present, and shifts clear of an open
  right-hand sidebar;
- `ui.cornerWidget: false` removes it. Bottom-right is deliberate: top-right is
  where most applications keep their own controls.

---

## 30. Commands

Internally, expose actions in a way plugins/UI can invoke consistently.

Candidate commands:

```text
annotate.toggle
annotate.enter
annotate.exit
note.create
note.edit
note.delete
note.copy-link
note.scroll-to
sidebar.toggle
note.archive
note.unarchive
export.json
export.markdown
import.json
```

A command registry would make Tampermonkey menu commands, keyboard shortcuts, Webmods commands, and UI buttons share behavior.

---

## 31. Testing

### Unit tests

Cover:

- URL normalization;
- page identity;
- anchor generation;
- anchor resolution;
- fuzzy recovery;
- block scoring;
- serialization;
- import migrations;
- storage adapters;
- share URL encoding/decoding.

### Browser/integration tests

Test against representative pages:

- static article;
- documentation site;
- GitHub-like complex page;
- SPA;
- page with aggressive CSS;
- page with dynamically inserted content;
- page containing forms/controls;
- page whose DOM changes between annotation creation and reload.

Important regression case:

1. create annotation;
2. alter surrounding DOM structure;
3. reload annotation;
4. verify correct block is recovered or safely reported detached.

---

## 32. Milestones

### Milestone 1 — Annotation Core

- TypeScript project/build pipeline
- annotate/explore mode
- block detection
- hover highlight
- block click
- Markdown note composer
- anchor generation
- anchor resolution
- in-memory storage
- lifecycle/events

### Milestone 2 — Persistent Tampermonkey MVP

- Tampermonkey storage adapter
- cross-site logical annotation database
- current-page notes sidebar
- navigate from sidebar to note
- local annotation links
- minified standalone build
- reference userscript

At this point the project is already useful.

### Milestone 3 — Portability

- IndexedDB/localStorage adapters
- JSON export/import
- Markdown export
- schema migrations
- inline share URLs for small annotations

### Milestone 4 — Robustness

- SPA support
- dynamic content handling
- improved anchor recovery
- detached-note UI
- performance tuning
- accessibility pass

### Milestone 5 — Excalidraw

- attachment plugin API
- lazy Excalidraw integration
- scene persistence
- previews
- JSON portability

### Milestone 6 — AI Conversation

- plugin sidebar tabs
- generic chat provider interface
- Claude-compatible provider
- page/block/note context actions
- streamed responses where provider supports them

### Milestone 7 — Global Knowledge Layer

- all-pages annotation browser
- search
- domain/page filtering
- tags/metadata if useful
- remote storage/share adapter
- optional synchronization

---

## 33. MVP Definition

The MVP is complete when this workflow works reliably:

1. User installs/loads the userscript.
2. User activates annotation mode.
3. Moving over the page highlights sensible content blocks.
4. User clicks a block.
5. User writes a Markdown note.
6. Note is saved in the shared Tampermonkey annotation store.
7. User leaves/reloads the page.
8. Annotation is restored and attached to the correct block.
9. User opens sidebar and sees all notes on that page.
10. Clicking a note scrolls to and highlights its block.
11. User copies a note anchor URL.
12. Opening that URL on the same annotation store navigates to the note.
13. User can export the database as JSON.

Excalidraw and AI are explicitly **not required for MVP**.

---

## 34. Design Principles

1. **Small core, powerful extensions.**
2. **Tampermonkey is a host, not the architecture.**
3. **Storage is an adapter.**
4. **AI is a plugin.**
5. **Excalidraw is an attachment/plugin.**
6. **JSON is canonical; Markdown is a projection.**
7. **Anchors must survive reasonable page changes.**
8. **Never silently attach a note to the wrong content.**
9. **No backend is required for the basic product.**
10. **One-import usage should remain possible.**
11. **Optional features must not bloat the default bundle.**
12. **Host pages should behave normally outside annotation mode.**
13. **Prefer Webmods conventions where they already solve the same lifecycle/plugin problem.**

---

## 35. Open Decisions Before Implementation

These should be resolved after inspecting/alignment with Webmods internals:

1. Final package/repository name (`webmods-annotate`, package inside `webmods`, etc.).
2. Existing Webmods plugin lifecycle and whether `annotator.use()` should reuse it.
3. Existing Webmods command/shortcut system.
4. Exact default Tampermonkey storage mechanism and namespacing.
5. Whether text-range annotations belong in V1 or V1.1.
6. Whether the default sidebar is core or a first-party UI plugin.
7. Markdown editor implementation (plain textarea initially is preferred).
8. Exact fragment namespace (`#wm-note=...` or equivalent).
9. Maximum inline-share payload size.
10. Whether global annotation search ships before or after AI/Excalidraw.

---

## 36. Initial Recommended Scope

Start deliberately smaller than the full vision:

```text
core
+ robust block anchors
+ Tampermonkey shared storage
+ simple Markdown notes
+ notes sidebar
+ note anchor links
+ JSON import/export
+ minified one-import build
```

Prove that this layer works reliably across real websites first.

Then add:

```text
Excalidraw
AI conversation
remote sync/share
global search
text-range annotations
```

The hardest and most valuable engineering problem is not the note editor or AI pane: it is **reliably identifying, persisting, and recovering an annotated location on arbitrary changing web pages**. The project architecture should optimize for getting that foundation right.
