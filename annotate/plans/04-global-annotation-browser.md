# Plan 04 — Global annotation browser (spec Milestone 7, local part)

Goal: browse and search EVERY annotation across all sites from any page: filter by
domain/text, jump to the original page+note, export a single page's notes. Local
only — no remote sync/share in this plan.

Spec sections: §15 (the view), §13 (DB structure already supports it), §20 (export
selected pages), §12 (`listPages`/`listAll` exist on `DocumentStorage`).

**Depends on:** nothing hard; nicer after Plan 01 (detached badge) and Plan 03
(`activateSidebarTab` on PluginContext — if Plan 03 hasn't landed, add that
PluginContext method here exactly as specified there).

Non-goals (do NOT build): tags, remote storage, cross-page detached repair,
editing notes from the global view (jump to the page to edit).

---

## Shape: a plugin with a sidebar tab

New file `src/plugins/global-browser.ts`:

```ts
export interface GlobalBrowserPlugin extends AnnotatorPlugin {
  /** Programmatic search over all annotations; exposed for tests. */
  search(query: string): Promise<GlobalSearchResult[]>;
}

export interface GlobalSearchResult {
  page: PageIdentity;
  annotation: Annotation;
  /** Which field matched: "body" | "quote" | "url" | "title" */
  matched: string;
}

export function createGlobalBrowserPlugin(): GlobalBrowserPlugin;
```

`setup(ctx)` registers a sidebar tab `{ id: "all-pages", label: "All pages" }` and a
command `browser.search` → `plugin.search`.

If `ctx.storage.listAll` or `ctx.storage.listPages` is missing (custom adapters may
omit them), the tab renders a single explanatory line
"This storage adapter does not support browsing all pages." and does nothing else.
No throw.

## Search semantics (pure function, unit-testable)

```ts
export function searchAnnotations(
  pages: { identity: PageIdentity; annotations: Annotation[] }[],
  query: string
): GlobalSearchResult[]
```

- Empty/whitespace query → every annotation (grouped order below).
- Tokenize the query on whitespace, lowercase. An annotation matches when EVERY
  token appears (case-insensitive substring) in at least one of:
  note body text, `anchor.textQuote.exact`, page `normalizedUrl`, page `title`.
- `matched` reports the first field (in that order) containing the first token.
- Special filter token `site:<text>` restricts to pages whose normalizedUrl host
  contains `<text>` (strip the token from text matching).
- Sort: by page (`normalizedUrl` asc), then `updatedAt` desc within a page.

## Tab UI

Same conventions as the chat tab (own `<style>` with `wm-gb-` prefixed classes,
plain DOM, everything created via `doc.createElement`, all user data set with
`textContent` or `renderMarkdown`).

Top→bottom:

1. **Search input** `<input type="search" aria-label="Search all annotations">`,
   debounced 200 ms. Placeholder: `Search notes… (site:example.com to filter)`.
2. **Summary line**: `N notes on M pages`.
3. **Page groups**: for each page (in result order):
   - Header row: page title (fallback: normalizedUrl), muted host, note count.
     Collapsible (`<button aria-expanded>`; default expanded when a query is active,
     collapsed when browsing without a query and there are > 5 pages).
   - "Export" button per page group → builds a single-page `ExportDocument`
     (reuse `validateExportDocument`'s shape: `{ format: "wm-annotate-export",
     schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(), pages: [thisPage] }`)
     and downloads it (copy the `download()` helper from `src/userscript.ts` into the
     plugin — or better, move `download()` into a new tiny `src/dom-utils.ts` and
     import it from both places).
   - Note rows: excerpt (first 120 chars of body, `textContent`), quote context line,
     `updatedAt` as `YYYY-MM-DD`. Row click →
     - Same page (`page.id === ctx.getPage().id`): `ctx.scrollToNote(id)` +
       `ui focus` via command `note.scroll-to`; also switch to the Notes tab.
     - Other page: `window.open(noteUrl, "_blank")` where
       `noteUrl = annotation.anchor.url.split("#")[0] + "#wm-note=" + encodeURIComponent(annotation.id)`.
       (The target page's own annotator instance handles the fragment on load.)

Refresh the list when the tab is (re)rendered and after `note:save` / `note:delete`
events (subscribe in `setup`, dispose in `destroy`; re-render only if the tab is
currently mounted — track mounted state via the render callback's cleanup function,
which the sidebar already supports: return a cleanup fn from `render`).

## Data loading

`loadAll()`:

```ts
const [all, summaries] = await Promise.all([storage.listAll!(), storage.listPages!()]);
// group `all` by pageId; identity from summaries, fallback identity from anchor.url
```

(Exactly the grouping already implemented in `src/plugins/portable-data.ts
collectPages()` — extract that into a shared exported helper
`collectPages(storage, currentPage)` in portable-data.ts and reuse it; do not
duplicate the logic.)

Cap protection: if `all.length > 5000`, render only the first 5000 (sorted) and a
warning line `Showing 5000 of N notes — refine your search.` — and `log` nothing.

## Userscript host

`src/userscript.ts`: `annotator.use(createGlobalBrowserPlugin())` unconditionally
(it is tiny and lazy — all work happens when the tab is opened), plus a menu command
`Browse all annotations` that opens the sidebar on the `all-pages` tab.

## Tests

`test/global-browser.test.ts`:

1. `searchAnnotations`: empty query returns all; multi-token AND semantics;
   matches body/quote/url/title with correct `matched` field; `site:` filter;
   sorting (page asc, updatedAt desc).
2. Plugin setup registers the tab + command; storage without `listAll` → tab renders
   the fallback message, `search()` resolves to `[]`.
3. `search()` end-to-end over a memory storage seeded with 3 pages / 5 notes.
4. Note-row URL construction: anchor url with an existing `#fragment` and with a
   query string both produce a single, correct `#wm-note=` fragment.
5. Re-render on `note:delete` (spy on the container's child count before/after).

Headless verify (`verify-global-browser.mjs`): seed localStorage-backed storage by
creating notes on the fixture page, then evaluate a second fixture page (different
file name = different page identity) and create notes there too — NOTE: `file://`
localStorage is per-directory-origin in Chrome; if the two fixtures don't share
storage, run a tiny `http-server` via node instead (`python3 -m http.server` is NOT
available inside the harness; use node: `import { createServer } from "node:http"`
serving the scratch dir). Checks: All pages tab lists 2 pages with counts; search
narrows; `site:` works; clicking a foreign note row opens a new tab that lands
scrolled+flashed on the right block (puppeteer: `browser.waitForTarget` then check
the new page's URL contains `#wm-note=` and `.wm-flash` exists). Screenshot the tab.

## Acceptance criteria

- [ ] From any page, the All pages tab shows every stored page with note counts and
      live search including `site:` filtering.
- [ ] Clicking a note from another page opens that page and auto-navigates to the
      note (existing fragment flow — no new navigation code in core).
- [ ] Per-page export downloads a valid `ExportDocument` that `importJSON` accepts.
- [ ] Adapters without `listAll` degrade to a message, never a crash.
- [ ] No new core changes except (if Plan 03 not done) `activateSidebarTab`.
