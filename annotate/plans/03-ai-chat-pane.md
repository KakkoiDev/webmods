# Plan 03 — AI conversation plugin (spec Milestone 6)

Goal: an optional Chat tab in the sidebar. The user picks a context (page / block /
note / all page notes), asks a question, and a pluggable provider answers — streamed
when the provider supports it. Ships with a Claude provider; core stays AI-free.

Spec sections: §18 (whole design), §25 (security: send only on explicit user action,
define what is sent), §14 (plugin tabs).

**Depends on:** Plan 01 Task 1 (storage `getSetting`/`setSetting`) for persisting the
provider config (API key, model).

Hard rules from the spec:
- Nothing AI-related may be imported by core files. New code lives in
  `src/plugins/chat.ts` + `src/providers/claude.ts` only, exported from `index.ts`.
- No request is ever sent without the user pressing Send.
- The provider decides prompt formatting; the plugin only assembles a structured
  `AnnotationChatContext` object.

---

## Public API (new file `src/plugins/chat.ts`)

```ts
export interface ChatMessage { role: "user" | "assistant"; content: string; }

export interface ChatRequest {
  messages: ChatMessage[];            // full visible transcript, oldest first
  context: AnnotationChatContext;     // structured page/annotation context
  signal?: AbortSignal;
}

export interface ChatResponse { content: string; }
export interface ChatChunk { delta: string; }

export interface ChatProvider {
  name: string;
  send(request: ChatRequest): AsyncIterable<ChatChunk> | Promise<ChatResponse>;
}

export interface AnnotationChatContext {
  page: PageIdentity;
  annotation?: Annotation;        // set for "this note" scope
  targetText?: string;            // set for "block"/"note" scopes: resolved block text (cap 4000 chars)
  surroundingText?: string;       // block scope: text of prev+next sibling blocks (cap 1000 chars)
  pageAnnotations?: Annotation[]; // set for "all notes" scope
  pageText?: string;              // set for "page" scope: document.body innerText, cap 12000 chars
}

export type ChatScope = "page" | "block" | "note" | "all-notes";

export interface ChatPluginOptions {
  provider: ChatProvider;
  /** Cap for pageText context, default 12000. */
  maxPageChars?: number;
}

export interface ChatPlugin extends AnnotatorPlugin {
  ask(scope: ChatScope, question: string, noteId?: string): Promise<string>; // programmatic entry, used by tests
  clearTranscript(): void;
}

export function createChatPlugin(options: ChatPluginOptions): ChatPlugin;
```

## Plugin behavior

`setup(ctx)`:

1. `ctx.addSidebarTab({ id: "chat", label: "Chat", render })`.
2. `ctx.addNoteAction({ id: "chat-note", label: "Ask AI", onClick })` — opens the
   sidebar Chat tab with scope preset to `note` and that note selected. Opening the
   tab from a note action requires a way to switch tabs: **add
   `activateSidebarTab(id: string)` to `PluginContext`** (implement in `annotator.ts`
   by exposing `ui.activateTab` — make `activateTab` public in `ui.ts`, then
   `activateSidebarTab: (id) => { ui.openSidebar(); ui.activateTab(id); }`).
3. `ctx.commands.register("chat.ask", ({scope, question, noteId}) => plugin.ask(...))`.

`destroy()`: abort any in-flight request (keep an `AbortController`), dispose tab and
action.

### Tab UI (rendered into the container the sidebar gives you)

Plain DOM, no framework, all elements created with `doc.createElement` (the sidebar
container is inside the shadow root — styles go into the existing `CSS` constant in
`ui.ts`? **No.** Plugins must not edit ui.ts. Instead: the plugin injects one
`<style>` element into its container with `wm-chat-*` classes; keep selectors
prefixed `wm-chat-`).

Layout top→bottom:

1. **Context row**: a `<select aria-label="Context">` with options
   `This page` (page) / `All notes on page` (all-notes) / `This note…` (note).
   When `note` is selected, a second `<select>` lists current page notes
   (`ctx.getNotes()`, label = first 40 chars of body text). Block scope is reached
   via the note scope (a note's block), not separately — simpler than a picker.
   A muted line under it always previews what will be sent, e.g.
   `Will send: page title + URL + 8.3k chars of page text`.
2. **Transcript**: scrollable list; user messages plain `textContent`; assistant
   messages rendered through `renderMarkdown` (import from `../markdown`).
3. **Input row**: `<textarea>` + Send button (also Cmd/Ctrl+Enter). While a request
   is in flight: Send becomes Stop (aborts), textarea disabled.
4. **Error line**: failures render as a `.wm-chat-error` text line (message only,
   never the stack), and the transcript keeps the user message so retry is easy.

Streaming: if `provider.send` returns an AsyncIterable, append a live assistant
message and update its markdown-rendered content per chunk (re-render throttled to
~10/s with a simple `setTimeout` gate). If it returns a Promise, show a `…` bubble
until it resolves.

Transcript is **in-memory per page load** (do not persist chat logs — privacy, §25).

### Context assembly (`buildContext(scope, noteId?)`)

- `page`: `{ page, pageText: document.body.innerText.slice(0, maxPageChars) }` —
  strip our own UI first: `innerText` of a clone? Simpler: temporarily fine because
  the shadow-root UI does not contribute to `body.innerText` (host has no slotted
  text) — verify this in a unit test rather than assuming.
- `note`: `{ page, annotation, targetText, surroundingText }` where `targetText` is
  the resolved block's `textContent` (cap 4000) and `surroundingText` is
  prev/next element sibling text (cap 1000 total). If the note is detached,
  `targetText` falls back to `annotation.anchor.textQuote?.exact`.
- `all-notes`: `{ page, pageAnnotations: ctx.getNotes().map(n => n.annotation) }`.

## Claude provider (new file `src/providers/claude.ts`)

```ts
export interface ClaudeProviderOptions {
  apiKey: string;
  model?: string;        // default "claude-sonnet-5"
  maxTokens?: number;    // default 1024
  endpoint?: string;     // default "https://api.anthropic.com/v1/messages"
  fetchFn?: typeof fetch; // injectable for tests + GM_xmlhttpRequest wrapper later
}
export function createClaudeProvider(options: ClaudeProviderOptions): ChatProvider;
```

- POST `endpoint` with headers:
  `content-type: application/json`, `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-dangerous-direct-browser-access: true` (required for browser-side calls).
- Body: `{ model, max_tokens, stream: true, system, messages }` where `system` is a
  short template the PROVIDER owns (spec: don't hard-code provider prompts in
  core/plugin): "You are helping a user understand and annotate a web page." plus a
  serialized context section (page title/URL, then whichever of
  targetText/pageText/annotations is present, each under a labelled heading,
  values fenced). `messages` = request.messages mapped 1:1.
- Streaming: parse SSE lines (`data: {...}`); yield
  `{ delta }` for `content_block_delta` events with `delta.type === "text_delta"`;
  stop on `message_stop` or `data: [DONE]`-style end; surface HTTP errors as thrown
  `Error(`Claude API ${status}: ${message from body if parseable}`)`.
- Respect `request.signal` (pass to fetch).
- Consult the `claude-api` skill / Anthropic docs if any of these constants look
  stale before hard-coding them.

Also export a trivial test/demo provider from `chat.ts`:

```ts
export function createEchoProvider(): ChatProvider // resolves with a canned summary of the context; used in tests/verify
```

## Userscript host wiring (`src/userscript.ts`)

- Read key/model with `storage.getSetting("chat.apiKey" | "chat.model")`.
- If an apiKey exists → `annotator.use(createChatPlugin({ provider: createClaudeProvider({ apiKey, model }) }))`.
- Add a Tampermonkey menu command `Configure AI chat…` that prompts
  (`prompt()` is fine) for the API key + model and saves them via `setSetting`,
  then alerts "reload the page to apply".
- The key lives in GM storage only; never put it in exports — **portable-data must
  exclude settings**: check `exportDB()`/`ExportDocument` — the export document
  already only contains `pages`, so nothing to do, but ADD a unit test locking that
  in (export after setSetting → JSON.stringify(doc) does not contain the key).

## Tests

`test/chat.test.ts` (fake provider, no network):

1. Lazy/tab registration: setup registers a "chat" sidebar tab, an "Ask AI" note
   action, and the `chat.ask` command.
2. `buildContext("note", id)` contains targetText from the resolved block and the
   annotation; detached note falls back to the stored quote.
3. `ask()` with a Promise-provider appends user+assistant messages; with an
   async-iterable provider, chunks concatenate in order.
4. Provider throwing → error shown, transcript keeps the user message, plugin
   usable for a second ask.
5. Abort: a provider that never resolves + `destroy()` → no unhandled rejection
   (assert the AbortSignal it received fired).
6. Settings never exported (see above).

`test/claude-provider.test.ts` (inject `fetchFn`):

1. Sends correct headers/body shape; messages mapped; context serialized into system.
2. Parses a canned SSE stream into the right delta sequence.
3. Non-200 → thrown error containing status.
4. Signal passed through to fetch.

Headless verify (`verify-chat.mjs`): userscript build won't have a key, so evaluate
extra JS that constructs the plugin with `createEchoProvider` — the userscript bundle
doesn't export internals, so ALSO build the library global (`dist/annotate.js`) into
the page and drive `WebmodsAnnotate.createAnnotator` + `createChatPlugin` directly.
Checks: Chat tab appears next to Notes; scope select lists a created note; sending
renders the echo answer as markdown; Stop button appears while pending; screenshot.

## Acceptance criteria

- [ ] Core bundle contains zero AI code paths executed at load (chat is used only via
      `annotator.use`); grep proves `providers/claude` is not imported by any core file.
- [ ] With a fake provider, full ask→stream→render loop works in unit tests; with the
      echo provider, works headlessly in the sidebar.
- [ ] Claude provider unit-verified against mocked fetch (headers, SSE parsing, abort).
- [ ] API key stored only in GM settings, excluded from exports, never logged.
- [ ] Nothing is sent anywhere without pressing Send (code-review the plugin for any
      fetch outside the Send path — there must be none).
