# Plan 01 — Robustness pass (spec Milestone 4)

Goal: annotations keep working on SPAs and dynamic pages, detached notes become
repairable instead of dead weight, and the UI passes a basic accessibility bar.

Spec sections: §23 (SPA), §24 (performance), §26 (accessibility), §14 (detached notes
in sidebar), §9 ("do not silently attach").

This plan has 5 independent tasks. Do them in order; each is separately committable.

---

## Task 1 — Settings helper on storage (needed by later plans)

The DB document already has an unused `settings?: Record<string, unknown>` field.
Expose it.

**Edit `src/types.ts`** — add to `AnnotationStorage`:

```ts
getSetting?<T = unknown>(key: string): Promise<T | undefined>;
setSetting?(key: string, value: unknown): Promise<void>;
```

**Edit `src/storage.ts`** — implement on `DocumentStorage`:

```ts
async getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const db = await this.read();
  return db.settings?.[key] as T | undefined;
}
async setSetting(key: string, value: unknown): Promise<void> {
  const db = await this.read();
  db.settings = { ...db.settings, [key]: value };
  await this.write(db);
}
```

For `createIndexedDBStorage`, implement using the existing `meta` object store
(`put(value, "setting:" + key)` / `get("setting:" + key)`).

**Tests** (`test/storage.test.ts`): round-trip a setting on memory and localStorage
adapters; settings survive adapter re-creation; `getSetting` of a never-set key
returns `undefined`.

---

## Task 2 — Detached-note repair (re-attach UI)

A detached note currently shows a red "detached" badge and nothing else can be done
with it. Add a **Re-attach** flow.

### Behavior

1. Sidebar card of a detached note shows a `Re-attach` button (in `.wm-note-actions`,
   before Delete; only when `resolution.status === "detached"`).
2. Clicking it: closes nothing, sets the annotator into a **re-anchor session**:
   annotate-mode-style hover highlighting, mode pill text
   `"Pick a new block for this note (Esc to cancel)"`.
3. Clicking a block: build a fresh anchor with `createAnchor(block, page.url)`,
   save via `updateNote(id, {})`-style path **but anchors aren't in the updateNote patch
   type** — so add a dedicated core method (below). Then `refresh()`, exit the session,
   `ui.focusNote(id)`.
4. Escape cancels the session and returns to the previous mode.

### Core changes

**`src/types.ts`** — add to `Annotator`:

```ts
reanchorNote(id: string, element: Element): Promise<Annotation>;
```

**`src/annotator.ts`** — implement next to `updateNote`:

```ts
async function reanchorNote(id: string, element: Element): Promise<Annotation> {
  const existing = await storage.get(id);
  if (!existing) throw new Error(`Annotation not found: ${id}`);
  const annotation: Annotation = { ...existing, anchor: createAnchor(element, page.url), updatedAt: Date.now() };
  await storage.save(annotation);
  emitter.emit("note:update", { annotation });
  emitter.emit("note:save", { annotation });
  await refresh();
  return annotation;
}
```

The re-anchor session itself lives in `annotator.ts` as a module-level state
`let reanchoringId: string | null = null`:

- In `onPointerMove` / `onClick`: treat `reanchoringId !== null` exactly like annotate
  mode (hover + block resolution), but on click call
  `reanchorNote(reanchoringId, block)` then clear `reanchoringId` and restore mode.
- In `onKeydown`: Escape while `reanchoringId` clears it (before the existing
  annotate-mode Escape branch).
- Enter the session from a new `NoteCallbacks` member `onReattach(id)` wired
  `ui → annotator` the same way `onEdit` is (see `AnnotatorUI` constructor call).
- While a session is active, `ui.setModeIndicator(true)` with custom text — add an
  optional `text` param: `setModeIndicator(on: boolean, text?: string)`.

**`src/ui.ts`** — in `renderNotesTab()`, for detached notes add:

```ts
if (detached) {
  actions.appendChild(this.makeButton("Re-attach", "wm-btn", () => this.noteCallbacks.onReattach(id)));
}
```

Add a command `note.reattach` that starts the session (register in annotator.ts).

### Tests

- `test/annotator.test.ts`: create a note, destroy the block, refresh → detached;
  call `annotator.reanchorNote(id, otherElement)` → note resolves to `otherElement`,
  `updatedAt` bumped, anchor selector points at the new element.
- Headless verify: create note on `#p1`, mutate the page so it detaches
  (replace body content, keep a different paragraph), reload+inject, sidebar shows
  `detached` badge + Re-attach button; click Re-attach, click the new paragraph,
  card loses the badge, marker appears. Screenshot before/after.

---

## Task 3 — Dynamic-content re-resolution (MutationObserver)

Late-rendered pages (docs sites, SPAs) mount content after `refresh()` ran, so notes
sit detached until something calls `refresh()`. Fix with a *bounded* observer —
spec §23 says use MutationObserver sparingly.

### Behavior (all inside `src/annotator.ts`)

```ts
let observer: MutationObserver | null = null;
let observerRetries = 0;
const OBSERVER_MAX_RETRIES = 5;
const OBSERVER_DEBOUNCE_MS = 400;

function ensureObserver(): void {
  // Called at the end of refresh(). Only observe while something is detached.
  const hasDetached = resolved.some((n) => n.resolution.status === "detached");
  if (!hasDetached || observerRetries >= OBSERVER_MAX_RETRIES) { stopObserver(); return; }
  if (observer) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  observer = new MutationObserver((mutations) => {
    // Ignore mutations inside our own UI.
    if (mutations.every((m) => m.target instanceof Element && isAnnotatorUI(m.target))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { observerRetries++; void refresh(); }, OBSERVER_DEBOUNCE_MS);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
}
function stopObserver(): void { observer?.disconnect(); observer = null; }
```

- Reset `observerRetries = 0` whenever the page identity changes (inside `refresh()`
  where `page:change` is emitted) and in `handleNoteFragment`.
- Call `stopObserver()` in `destroy()` (add to `cleanups`).
- IMPORTANT: `refresh()` re-renders markers which mutates our host — but the host is
  outside `doc.body`? **No** — the host is appended to `document.documentElement`, so
  body mutations exclude it already. Do not move the host into body.

### Tests

- Unit: create annotator with a note whose target doesn't exist yet → detached;
  append the matching element to body; wait ~1s (vitest `vi.waitFor` or a polling
  loop up to 2s) → note resolved, and the observer disconnected (no handle leak:
  assert a second unrelated DOM mutation does not trigger more refreshes — spy on
  `storage.getPage` call count stays stable).
- Unit: retries cap — with a permanently-missing target, mutate the DOM 10 times,
  assert `storage.getPage` was called at most `1 + OBSERVER_MAX_RETRIES` times.

---

## Task 4 — Performance guards

Three cheap, measurable guards (spec §24):

1. **rAF-throttle `onPointerMove`** in `annotator.ts`: keep the latest event in a
   variable; only run block resolution inside `requestAnimationFrame`, one frame at
   a time (same pattern as `scheduleReposition()` in `ui.ts`).
2. **Cap candidate scans** in `anchors.ts` `candidateElements()`: if
   `doc.querySelectorAll(selector).length > 20_000`, return only the first 20 000.
   (Fuzzy matching over more is pointless and janky.)
3. **Cache block text during one resolution pass**: `resolveAnchor` currently calls
   `blockText(el)` repeatedly on the same elements across strategies. Add a
   `WeakMap<Element, string>` created per `resolveAnchor` call, pass it through the
   helpers (`verifyAgainstQuote`, `fingerprintScore`, exact-quote scan).

No public API changes. Tests: existing suites must stay green;
add one unit test asserting `resolveAnchor` still returns identical results on the
fixtures in `test/anchors.test.ts` (import both paths' expectations — i.e. just keep
the existing tests passing; add a test with 100 sibling paragraphs where the right
one is still found).

---

## Task 5 — Accessibility pass

All in `src/ui.ts` unless noted (spec §26):

1. **aria-live mode announcements**: add a visually-hidden `<div aria-live="polite">`
   to the layer; `setModeIndicator` writes "Annotation mode on/off" (and the custom
   re-attach text) into it.
2. **Composer focus trap**: on Tab/Shift+Tab inside `.wm-composer`, cycle focus
   between textarea and buttons (query `textarea, button` inside the composer,
   wrap around at the ends). On open, focus the textarea (already done). On close,
   return focus to `document.body` — store and restore `doc.activeElement` if it is
   still connected.
3. **Sidebar keyboard shortcut**: add `shortcuts.sidebar` option to
   `AnnotatorOptions` (default `"alt+shift+s"`, same `matchesShortcut` helper,
   same input-field guard as the toggle shortcut) → `sidebar.toggle` command.
4. **Sidebar tabs arrow-key navigation**: on the tab bar, ArrowLeft/ArrowRight move
   `aria-selected` + focus between tabs (standard tablist pattern);
   the tab bar already has `role="tablist"` and buttons have `role="tab"`.
5. **Escape closes the sidebar** when it is open, annotate mode is off, and no
   composer is open (add to `onKeydown` in annotator.ts, lowest priority branch).

Visually-hidden CSS (add to the `CSS` constant):

```css
.wm-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
```

Tests: unit-test the shortcut option and Escape-closes-sidebar via dispatched
`KeyboardEvent`s (see how existing tests drive events); headless verify tabs
arrow-navigation and that the aria-live region updates on toggle.

---

## Acceptance criteria

- [ ] Detached note on a real page can be re-attached in ≤3 clicks; the repaired
      anchor survives reload.
- [ ] A note whose target renders 2s after page load attaches without any manual
      `refresh()` call; the observer disconnects afterwards (verify via
      `getEventListeners`-style check or retry-count assert in unit test).
- [ ] Pointer movement in annotate mode causes at most one block resolution per frame.
- [ ] Alt+Shift+S toggles the sidebar; tablist works with arrow keys; mode changes
      are announced via aria-live; Esc closes sidebar/composer/mode in the right order.
- [ ] `SCHEMA_VERSION` unchanged (nothing here changes stored data shape).
