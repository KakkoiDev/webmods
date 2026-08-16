# Plan 02 — Text-range annotations

Goal: annotate a text **selection** (part of a block), not just whole blocks.
The anchor schema already reserves `textQuote` (with prefix/suffix) and
`textPosition` for this (spec §9); this plan makes them first-class.

Spec sections: §9 (anchor schema, "schema should permit later text-range
annotations"), §35.5 (V1.1 feature — this is that follow-up).

**Depends on:** Plan 01 Task 4 (the per-resolution text cache) is nice-to-have but
not required. No storage schema bump is needed — `Anchor` only gains an optional
field, and old annotations (no `kind`) keep behaving as blocks.

---

## Data model

**`src/types.ts`** — extend `Anchor` (all optional, backward compatible):

```ts
export interface Anchor {
  url: string;
  /** "block" (default when absent) or "range" for a text selection inside a block. */
  kind?: "block" | "range";
  selector?: string;
  xpath?: string;
  textQuote?: TextQuote;
  textPosition?: { start: number; end: number }; // offsets into the block's normalized text
  fingerprint?: Fingerprint;
}
```

Extend `AnchorResolution` so range hits can carry the DOM Range:

```ts
export type AnchorResolution =
  | { status: "resolved"; element: Element; confidence: number; range?: Range }
  | { status: "detached"; reason?: string };
```

`range` is present only for `kind: "range"` anchors that fully resolved; a range
anchor whose block was found but whose text was not falls back to
`{ status: "resolved", element, confidence: <block confidence * 0.8> }` with **no**
`range` — the note reattaches at block level rather than silently pointing at the
wrong words (spec principle 8), and the sidebar shows a "text moved" badge (below).

## Anchor creation

**New functions in `src/anchors.ts`:**

```ts
/** Normalized-text offset mapping for one block. */
export function blockTextWithMap(block: Element): { text: string; nodes: { node: Text; start: number; end: number }[] }
```

Implementation: TreeWalker over `Text` nodes in the block (skip nodes inside
`[data-wm-annotate-ui]`), concatenating `node.data` with the SAME whitespace
normalization as `normalizeText` applied to the concatenation — careful: you cannot
normalize per-node and keep offsets. Do it in two steps:

1. Concatenate raw node text, recording each node's [rawStart, rawEnd).
2. Build the normalized string once, recording for every normalized index the raw
   index it came from (collapse `\s+` runs to one space; trim ends).
   Keep `normToRaw: number[]` alongside.

Return enough to map a normalized [start,end) back to (node, offsetInNode) pairs.

```ts
export function createRangeAnchor(range: Range, block: Element, url: string): Anchor
```

- `kind: "range"`.
- Compute the selection's normalized text and its [start,end) inside the block's
  normalized text via `blockTextWithMap`.
- `textQuote`: `exact` = the selected normalized text (cap 300 chars);
  `prefix` = up to 32 normalized chars before `start`; `suffix` = 32 after `end`
  (both from within the block — NOT from sibling elements like block anchors do).
- `textPosition`: `{ start, end }`.
- `selector`/`xpath`/`fingerprint`: same as `createAnchor(block, url)` — reuse it and
  override the quote/position/kind fields.

```ts
export function resolveRangeInBlock(block: Element, anchor: Anchor): Range | null
```

Strategy, given the block's `{ text, ... }` map:

1. If `textPosition` and `text.slice(start, end) === textQuote.exact` → build Range.
2. Else find `textQuote.exact` in `text` via `indexOf`; if multiple occurrences,
   disambiguate with prefix/suffix (score each occurrence: +1 if the 32 chars before
   match `prefix`, +1 if after match `suffix`; take the best; ties → first).
3. Else fuzzy: slide a window of `exact.length` over `text` in steps of 20 chars,
   `textSimilarity` ≥ 0.8 → refine ±20 chars around best window for the best exact
   window; build Range from the winner.
4. Else `null`.

Building the Range: map normalized [start,end) → raw offsets → (Text node, offset)
via the map; `range.setStart(node, off)` / `setEnd(...)`.

**`resolveAnchor`** — after the existing block resolution succeeds and
`anchor.kind === "range"`, call `resolveRangeInBlock`; attach `range` on success,
degrade confidence `* 0.8` and omit `range` on failure. No other resolution logic
changes.

## Capturing selections in annotate mode

**`src/annotator.ts`**, inside `onClick` (annotate mode):

```ts
const selection = win.getSelection();
if (selection && !selection.isCollapsed && selection.rangeCount) {
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const el = container instanceof Element ? container : container.parentElement;
  const block = el && !isAnnotatorUI(el) ? blockResolver(el, { exclude }) : null;
  if (block && block.contains(range.commonAncestorContainer)) {
    e.preventDefault(); e.stopPropagation();
    ui.setHoverTarget(null);
    void composeAt(block, range);   // extend composeAt with an optional range param
    return;
  }
}
// ...existing block-click path unchanged
```

`composeAt(target, range?)` uses `createRangeAnchor(range, target, page.url)` when a
range is given, else `createAnchor` as today.

Note on UX: a click that ends a text selection fires AFTER `mouseup`, and the
selection is still live inside the click handler — this works. But hover highlighting
fights selection dragging: while the primary button is down, **suppress hover updates**
(`onPointerMove`: `if (e.buttons & 1) return;`).

## Rendering range highlights

Whole-block notes show a gutter marker. Range notes additionally paint the selected
text.

**`src/ui.ts`:**

- `renderNotes` currently only draws markers. For each resolved note whose
  `resolution.range` exists, also store the range; a new private method
  `repositionRangeHighlights()` (called from the same rAF as `repositionMarkers`)
  draws one absolutely-positioned box per `range.getClientRects()` rect:

```css
.wm-range {
  position: fixed; pointer-events: none;
  background: rgba(245, 158, 11, 0.28); border-radius: 2px;
}
```

- Cap: max 50 rects per note (very long selections); skip rects with zero area.
- Rebuild rect boxes on every `renderNotes` (ranges go stale when the DOM changes;
  `refresh()` already re-resolves).
- The gutter marker still renders for range notes (same numbering).

Sidebar card: when `anchor.kind === "range"`, the `.wm-note-context` excerpt should
quote `textQuote.exact` (it already does — verify). When a range note resolved at
block level only (no `range` on the resolution), show a badge
`<span class="wm-badge wm-badge-attach">text moved</span>` next to the context.

`flash(target)` for a range note should flash the block (unchanged) — do not attempt
range-rect flashing in this iteration.

## Tests

`test/range-anchors.test.ts` (new):

1. `blockTextWithMap` — normalization matches `normalizeText(block.textContent)`;
   offsets map back to correct Text nodes across nested inline elements
   (`<p>ab <em>cd</em> ef</p>`).
2. `createRangeAnchor` over a selection spanning two text nodes → correct exact,
   prefix, suffix, textPosition, `kind: "range"`.
3. Resolve round-trip on unchanged DOM → `range` returned, `toString()` equals the
   selected text.
4. Text edited slightly (one word changed elsewhere in the block) → still resolves
   via position/quote.
5. Selected sentence deleted from the block → resolution has element but NO range,
   confidence < block confidence.
6. Duplicate occurrences (`"foo bar"` appears twice) disambiguated by prefix/suffix.
7. Legacy anchor without `kind` behaves exactly as before (run one existing block
   fixture through and assert no `range` on the resolution).

`test/annotator.test.ts` — one test: `createNote` with a range anchor stores and
restores `kind: "range"` (storage round-trip).

Headless verify (`verify-ranges.mjs`): select part of `#p1` with mouse drag
(mouse.down/move/up over the text), click the selection, save note; assert
`.wm-range` boxes exist and overlap `#p1`'s rect; reload → highlight reappears;
screenshot; edit page text so the sentence disappears → "text moved" badge, marker
still present.

## Acceptance criteria

- [ ] Selecting text in annotate mode and clicking it creates a range note; whole-block
      click still works exactly as before.
- [ ] Range highlight visible after reload, positioned over the text, scroll-synced.
- [ ] Removing the selected sentence degrades gracefully to a block-level attachment
      with a visible "text moved" indicator — never highlights the wrong text.
- [ ] All existing tests pass unmodified (except additive ones); old stored
      annotations load with no migration.
