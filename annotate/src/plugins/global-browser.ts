import { NOTE_FRAGMENT_PARAM, SCHEMA_VERSION } from "../types";
import type { Annotation, AnnotatorPlugin, PageIdentity, PluginContext } from "../types";
import { isArchived } from "../archive";
import { collectPages, type PageGroup } from "./portable-data";
import type { ExportDocument } from "./portable-data";
import { download } from "../dom-utils";

export type MatchField = "body" | "quote" | "url" | "title";

export interface GlobalSearchResult {
  page: PageIdentity;
  annotation: Annotation;
  /** Which field the first query token matched. */
  matched: MatchField;
}

export interface GlobalBrowserPlugin extends AnnotatorPlugin {
  search(query: string): Promise<GlobalSearchResult[]>;
}

/** Very large collections are truncated rather than rendered in full. */
export const MAX_RESULTS = 5000;

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

interface ParsedQuery {
  tokens: string[];
  sites: string[];
}

function parseQuery(query: string): ParsedQuery {
  const tokens: string[] = [];
  const sites: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith("site:")) {
      const value = raw.slice("site:".length);
      if (value) sites.push(value);
    } else {
      tokens.push(raw);
    }
  }
  return { tokens, sites };
}

const FIELD_ORDER: MatchField[] = ["body", "quote", "url", "title"];

function fieldValues(page: PageIdentity, annotation: Annotation): Record<MatchField, string> {
  return {
    body: annotation.body.text.toLowerCase(),
    quote: (annotation.anchor.textQuote?.exact ?? "").toLowerCase(),
    url: page.normalizedUrl.toLowerCase(),
    title: (page.title ?? "").toLowerCase(),
  };
}

/**
 * Search every stored annotation. All tokens must match (AND); a token matches
 * when it appears in the note body, the anchored quote, the page URL, or the
 * page title. `site:<text>` restricts to pages whose host contains <text>.
 */
export function searchAnnotations(pages: PageGroup[], query: string): GlobalSearchResult[] {
  const { tokens, sites } = parseQuery(query);

  const results: GlobalSearchResult[] = [];
  for (const { identity, annotations } of pages) {
    if (sites.length && !sites.every((s) => hostOf(identity.normalizedUrl).includes(s))) continue;
    for (const annotation of annotations) {
      const values = fieldValues(identity, annotation);
      const matchesAll = tokens.every((token) => FIELD_ORDER.some((field) => values[field].includes(token)));
      if (!matchesAll) continue;
      const first = tokens[0];
      const matched = first ? (FIELD_ORDER.find((field) => values[field].includes(first)) ?? "body") : "body";
      results.push({ page: identity, annotation, matched });
    }
  }

  return results.sort((a, b) => {
    const byPage = a.page.normalizedUrl.localeCompare(b.page.normalizedUrl);
    if (byPage !== 0) return byPage;
    return b.annotation.updatedAt - a.annotation.updatedAt;
  });
}

/** Link that lands on the annotation's own page, scrolled to the note. */
export function noteLink(annotation: Annotation): string {
  const base = annotation.anchor.url.split("#")[0];
  return `${base}#${NOTE_FRAGMENT_PARAM}=${encodeURIComponent(annotation.id)}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const CSS = `
.wm-gb { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.wm-gb input {
  font: inherit; font-size: 13px; padding: 5px 8px; width: 100%;
  border: 1px solid #d0d7de; border-radius: 6px;
}
.wm-gb input:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
.wm-gb-summary { font-size: 12px; color: #57606a; }
.wm-gb-list { flex: 1; overflow: auto; }
.wm-gb-page { border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
.wm-gb-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #f6f8fa; }
.wm-gb-toggle {
  font: inherit; font-size: 12.5px; font-weight: 600; text-align: left; flex: 1;
  border: 0; background: none; cursor: pointer; color: #1f2328; padding: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wm-gb-toggle:focus-visible { outline: 2px solid #6366f1; }
.wm-gb-host { font-size: 11px; color: #57606a; font-weight: 400; }
.wm-gb-count { font-size: 11px; color: #57606a; }
.wm-gb-export {
  font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328;
}
.wm-gb-note {
  display: block; width: 100%; text-align: left; font: inherit; cursor: pointer;
  border: 0; border-top: 1px solid #d0d7de; background: #fff; padding: 7px 9px;
}
.wm-gb-note:hover { background: #f6f8fa; }
.wm-gb-note:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
.wm-gb-excerpt { font-size: 12.5px; color: #1f2328; }
.wm-gb-context { font-size: 11px; color: #57606a; margin-top: 3px; }
.wm-gb-empty, .wm-gb-warn { font-size: 12.5px; color: #57606a; padding: 8px 2px; }
`;

export function createGlobalBrowserPlugin(): GlobalBrowserPlugin {
  let ctx: PluginContext | null = null;
  const cleanups: Array<() => void> = [];
  let render: (() => void) | null = null;

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("global-browser plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  const supported = (c: PluginContext) => !!(c.storage.listAll && c.storage.listPages);

  async function search(query: string): Promise<GlobalSearchResult[]> {
    const c = requireCtx();
    if (!supported(c)) return [];
    return searchAnnotations(await collectPages(c.storage, c.getPage()), query);
  }

  function exportPage(group: PageGroup): void {
    const doc: ExportDocument = {
      format: "wm-annotate-export",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      pages: [group],
    };
    const slug = (group.identity.title || hostOf(group.identity.normalizedUrl) || "page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    download(`webmods-annotations-${slug || "page"}.json`, JSON.stringify(doc, null, 2), "application/json");
  }

  const plugin: GlobalBrowserPlugin = {
    name: "global-browser",

    setup(pluginCtx) {
      ctx = pluginCtx;
      cleanups.push(pluginCtx.commands.register("browser.search", (query) => search(String(query ?? ""))));
      cleanups.push(pluginCtx.commands.register("browser.open", () => pluginCtx.activateSidebarTab("all-pages")));

      cleanups.push(
        pluginCtx.addSidebarTab({
          id: "all-pages",
          label: "All pages",
          render(container) {
            const style = document.createElement("style");
            style.textContent = CSS;
            container.appendChild(style);

            const root = document.createElement("div");
            root.className = "wm-gb";
            container.appendChild(root);

            if (!supported(pluginCtx)) {
              const note = document.createElement("div");
              note.className = "wm-gb-empty";
              note.textContent = "This storage adapter does not support browsing all pages.";
              root.appendChild(note);
              return () => {};
            }

            const input = document.createElement("input");
            input.type = "search";
            input.setAttribute("aria-label", "Search all annotations");
            input.placeholder = "Search notes… (site:example.com to filter)";

            const summary = document.createElement("div");
            summary.className = "wm-gb-summary";

            const list = document.createElement("div");
            list.className = "wm-gb-list";
            root.append(input, summary, list);

            const collapsed = new Set<string>();
            let generation = 0;

            const paint = async () => {
              const mine = ++generation;
              const query = input.value.trim();
              let pages: PageGroup[];
              try {
                pages = await collectPages(pluginCtx.storage, pluginCtx.getPage());
              } catch {
                return;
              }
              if (mine !== generation) return; // a newer keystroke won

              const results = searchAnnotations(pages, query);
              const shown = results.slice(0, MAX_RESULTS);
              const byPage = new Map<string, GlobalSearchResult[]>();
              for (const r of shown) {
                const bucket = byPage.get(r.page.id) ?? [];
                bucket.push(r);
                byPage.set(r.page.id, bucket);
              }

              summary.textContent = `${results.length} note${results.length === 1 ? "" : "s"} on ${byPage.size} page${
                byPage.size === 1 ? "" : "s"
              }`;
              list.textContent = "";

              if (results.length > shown.length) {
                const warn = document.createElement("div");
                warn.className = "wm-gb-warn";
                warn.textContent = `Showing ${shown.length} of ${results.length} notes — refine your search.`;
                list.appendChild(warn);
              }
              if (!shown.length) {
                const empty = document.createElement("div");
                empty.className = "wm-gb-empty";
                empty.textContent = query ? "No notes match that search." : "No annotations stored yet.";
                list.appendChild(empty);
                return;
              }

              // Browsing without a query and lots of pages: start collapsed.
              const collapseByDefault = !query && byPage.size > 5;

              for (const [pageId, group] of byPage) {
                const identity = group[0].page;
                const card = document.createElement("div");
                card.className = "wm-gb-page";
                card.dataset.pageId = pageId;

                const head = document.createElement("div");
                head.className = "wm-gb-head";

                const isCollapsed = collapsed.has(pageId) || (collapseByDefault && !collapsed.has(`open:${pageId}`));
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "wm-gb-toggle";
                toggle.setAttribute("aria-expanded", String(!isCollapsed));
                toggle.textContent = identity.title || identity.normalizedUrl;
                const host = document.createElement("span");
                host.className = "wm-gb-host";
                host.textContent = ` — ${hostOf(identity.normalizedUrl)}`;
                toggle.appendChild(host);
                toggle.addEventListener("click", () => {
                  if (collapsed.has(pageId)) {
                    collapsed.delete(pageId);
                    collapsed.add(`open:${pageId}`);
                  } else {
                    collapsed.add(pageId);
                    collapsed.delete(`open:${pageId}`);
                  }
                  void paint();
                });

                const count = document.createElement("span");
                count.className = "wm-gb-count";
                count.textContent = `${group.length}`;

                const exportBtn = document.createElement("button");
                exportBtn.type = "button";
                exportBtn.className = "wm-gb-export";
                exportBtn.textContent = "Export";
                exportBtn.setAttribute("aria-label", `Export annotations for ${identity.title || identity.normalizedUrl}`);
                exportBtn.addEventListener("click", () => {
                  const full = pages.find((p) => p.identity.id === pageId);
                  if (full) exportPage(full);
                });

                head.append(toggle, count, exportBtn);
                card.appendChild(head);

                if (!isCollapsed) {
                  for (const { annotation } of group) {
                    const row = document.createElement("button");
                    row.type = "button";
                    row.className = "wm-gb-note";
                    row.dataset.noteId = annotation.id;

                    const excerpt = document.createElement("div");
                    excerpt.className = "wm-gb-excerpt";
                    excerpt.textContent = annotation.body.text.slice(0, 120);
                    const context = document.createElement("div");
                    context.className = "wm-gb-context";
                    const quote = annotation.anchor.textQuote?.exact;
                    // Archived notes stay searchable here, labelled, so a note
                    // archived on a page you never revisit is still reachable.
                    const state = isArchived(annotation) ? "archived · " : "";
                    context.textContent = `${state}${formatDate(annotation.updatedAt)}${quote ? ` · ${quote.slice(0, 60)}` : ""}`;
                    row.append(excerpt, context);

                    row.addEventListener("click", () => {
                      if (pageId === pluginCtx.getPage().id) {
                        pluginCtx.activateSidebarTab("notes");
                        void pluginCtx.scrollToNote(annotation.id);
                      } else {
                        window.open(noteLink(annotation), "_blank", "noopener");
                      }
                    });
                    card.appendChild(row);
                  }
                }
                list.appendChild(card);
              }
            };

            render = () => void paint();

            let debounce: ReturnType<typeof setTimeout> | null = null;
            input.addEventListener("input", () => {
              if (debounce) clearTimeout(debounce);
              debounce = setTimeout(() => void paint(), 200);
            });

            void paint();

            return () => {
              if (debounce) clearTimeout(debounce);
              render = null;
            };
          },
        })
      );

      // Keep the list in step with edits made elsewhere, but only while mounted.
      cleanups.push(pluginCtx.on("note:save", () => render?.()));
      cleanups.push(pluginCtx.on("note:delete", () => render?.()));
    },

    destroy() {
      for (const off of cleanups.splice(0)) off();
      render = null;
      ctx = null;
    },

    search,
  };

  return plugin;
}
