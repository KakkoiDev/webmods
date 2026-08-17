import { isArchived } from "../archive";
import { download } from "../dom-utils";
import type { Annotation, AnnotationStorage, AnnotatorPlugin, PageIdentity, PluginContext } from "../types";
import { INLINE_FRAGMENT_PARAM, SCHEMA_VERSION } from "../types";

export interface ExportDocument {
  format: "wm-annotate-export";
  schemaVersion: number;
  exportedAt: number;
  pages: Array<{
    identity: PageIdentity;
    annotations: Annotation[];
  }>;
}

export type CollisionStrategy = "skip" | "replace" | "merge" | "duplicate";

export interface ImportResult {
  imported: number;
  skipped: number;
  replaced: number;
}

const INLINE_MAX_BYTES = 4096;

export function validateAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== "object") return false;
  const a = value as Annotation;
  return (
    typeof a.id === "string" &&
    typeof a.pageId === "string" &&
    typeof a.createdAt === "number" &&
    typeof a.updatedAt === "number" &&
    !!a.anchor &&
    typeof a.anchor === "object" &&
    typeof a.anchor.url === "string" &&
    !!a.body &&
    a.body.type === "markdown" &&
    typeof a.body.text === "string"
  );
}

export function validateExportDocument(value: unknown): value is ExportDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as ExportDocument;
  if (doc.format !== "wm-annotate-export") return false;
  if (typeof doc.schemaVersion !== "number" || doc.schemaVersion > SCHEMA_VERSION) return false;
  if (!Array.isArray(doc.pages)) return false;
  return doc.pages.every(
    (p) =>
      p &&
      typeof p === "object" &&
      p.identity &&
      typeof p.identity.id === "string" &&
      Array.isArray(p.annotations) &&
      p.annotations.every(validateAnnotation)
  );
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** "page" = this page, "site" = every page on this host, "all" = everything stored. */
export type ExportScope = "page" | "site" | "all";

export interface ExportOptions {
  scope?: ExportScope;
}

export interface PortableDataAPI {
  exportJSON(opts?: ExportOptions): Promise<ExportDocument>;
  importJSON(data: unknown, strategy?: CollisionStrategy): Promise<ImportResult>;
  exportMarkdown(opts?: ExportOptions): Promise<string>;
  /** Export and hand the file to the user in one step. */
  downloadExport(format: "json" | "markdown", opts?: ExportOptions): Promise<void>;
  createInlineURL(annotation: Annotation, page: PageIdentity): string;
  parseInlineFragment(hash: string): { page: PageIdentity; annotation: Annotation } | null;
}

export interface PortableDataPlugin extends AnnotatorPlugin, PortableDataAPI {}

export interface PageGroup {
  identity: PageIdentity;
  annotations: Annotation[];
}

/**
 * Group every stored annotation by page. Adapters without global listing
 * (`listAll`/`listPages`) degrade to the current page only.
 */
export async function collectPages(storage: AnnotationStorage, currentPage: PageIdentity): Promise<PageGroup[]> {
  if (storage.listAll && storage.listPages) {
    const [all, summaries] = await Promise.all([storage.listAll(), storage.listPages()]);
    const identities = new Map(summaries.map((s) => [s.page.id, s.page]));
    const byPage = new Map<string, Annotation[]>();
    for (const a of all) {
      const list = byPage.get(a.pageId) ?? [];
      list.push(a);
      byPage.set(a.pageId, list);
    }
    return [...byPage.entries()].map(([pageId, annotations]) => ({
      identity: identities.get(pageId) ?? {
        id: pageId,
        url: annotations[0]?.anchor.url ?? "",
        normalizedUrl: annotations[0]?.anchor.url ?? "",
      },
      annotations,
    }));
  }
  return [{ identity: currentPage, annotations: await storage.getPage(currentPage) }];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Narrow collected pages to an export scope. An unparseable current URL degrades to this page. */
export function filterPagesByScope(pages: PageGroup[], current: PageIdentity, scope: ExportScope): PageGroup[] {
  if (scope === "all") return pages;
  if (scope === "page") return pages.filter((p) => p.identity.id === current.id);
  const host = hostOf(current.normalizedUrl) ?? hostOf(current.url);
  if (!host) return pages.filter((p) => p.identity.id === current.id);
  return pages.filter((p) => (hostOf(p.identity.normalizedUrl) ?? hostOf(p.identity.url)) === host);
}

/** e.g. webmods-annotations-app.notion.com-2026-08-18.md */
export function exportFilename(scope: ExportScope, current: PageIdentity, extension: string, today = new Date()): string {
  const host = scope === "all" ? "all" : hostOf(current.normalizedUrl) ?? hostOf(current.url) ?? "page";
  return `webmods-annotations-${host}-${today.toISOString().slice(0, 10)}.${extension}`;
}

/** Markdown for one page: a title heading at `level`, then one heading per note. */
function pageSection(identity: PageIdentity, annotations: Annotation[], level = 1): string {
  const hash = "#".repeat(level);
  const lines: string[] = [`${hash} ${identity.title || identity.normalizedUrl}`, "", `Source: ${identity.url}`];
  for (const a of [...annotations].sort((x, y) => x.createdAt - y.createdAt)) {
    lines.push("");
    const heading = a.anchor.fingerprint?.nearbyHeading || a.anchor.textQuote?.exact?.slice(0, 60) || "Note";
    lines.push(`${hash}# ${heading}`);
    lines.push("");
    if (a.anchor.textQuote?.exact) {
      lines.push(`> ${a.anchor.textQuote.exact.slice(0, 200)}`);
      lines.push("");
    }
    lines.push(a.body.text);
    for (const att of a.attachments ?? []) {
      lines.push("");
      lines.push(`Attachment: ${att.id}.${att.type}`);
    }
  }
  return lines.join("\n");
}

export function createPortableDataPlugin(): PortableDataPlugin {
  let ctx: PluginContext | null = null;
  const cleanups: Array<() => void> = [];

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("portable-data plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  async function collectOwnPages(scope: ExportScope = "all"): Promise<ExportDocument["pages"]> {
    const { storage, getPage } = requireCtx();
    const current = getPage();
    return filterPagesByScope(await collectPages(storage, current), current, scope);
  }

  const plugin: PortableDataPlugin = {
    name: "portable-data",

    setup(pluginCtx) {
      ctx = pluginCtx;
      pluginCtx.commands.register("export.json", (opts) => plugin.exportJSON(opts as ExportOptions | undefined));
      pluginCtx.commands.register("export.markdown", (opts) => plugin.exportMarkdown(opts as ExportOptions | undefined));
      pluginCtx.commands.register("import.json", (data) => plugin.importJSON(data));

      // One-click exports in the sidebar header: the Notes tab exports this site,
      // the All pages tab exports everything, so the scope matches what is on screen.
      for (const [tab, scope, what] of [
        ["notes", "site", "this site"],
        ["all-pages", "all", "every site"],
      ] as Array<[string, ExportScope, string]>) {
        for (const format of ["markdown", "json"] as const) {
          cleanups.push(
            pluginCtx.addHeaderAction({
              id: `export-${scope}-${format}`,
              label: format === "json" ? "JSON" : "MD",
              title: `Export notes from ${what} as ${format === "json" ? "JSON" : "Markdown"}`,
              tabs: [tab],
              onClick: () => void plugin.downloadExport(format, { scope }),
            })
          );
        }
      }
    },

    destroy() {
      for (const off of cleanups.splice(0)) off();
      ctx = null;
    },

    async exportJSON(opts: ExportOptions = {}): Promise<ExportDocument> {
      return {
        format: "wm-annotate-export",
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        pages: await collectOwnPages(opts.scope ?? "all"),
      };
    },

    async downloadExport(format: "json" | "markdown", opts: ExportOptions = {}): Promise<void> {
      const scope = opts.scope ?? "all";
      const name = exportFilename(scope, requireCtx().getPage(), format === "json" ? "json" : "md");
      if (format === "json") {
        download(name, JSON.stringify(await plugin.exportJSON(opts), null, 2), "application/json");
      } else {
        download(name, await plugin.exportMarkdown(opts), "text/markdown");
      }
    },

    async importJSON(data: unknown, strategy: CollisionStrategy = "skip"): Promise<ImportResult> {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      if (!validateExportDocument(parsed)) {
        throw new Error("Invalid annotation export document");
      }
      const { storage, annotator } = requireCtx();
      const result: ImportResult = { imported: 0, skipped: 0, replaced: 0 };

      for (const pageEntry of parsed.pages) {
        for (const annotation of pageEntry.annotations) {
          const existing = await storage.get(annotation.id);
          if (!existing) {
            await storage.save(annotation, pageEntry.identity);
            result.imported++;
            continue;
          }
          switch (strategy) {
            case "skip":
              result.skipped++;
              break;
            case "replace":
              await storage.save(annotation, pageEntry.identity);
              result.replaced++;
              break;
            case "merge":
              if (annotation.updatedAt > existing.updatedAt) {
                await storage.save(annotation, pageEntry.identity);
                result.replaced++;
              } else {
                result.skipped++;
              }
              break;
            case "duplicate": {
              const copy: Annotation = { ...annotation, id: `${annotation.id}-imported-${Date.now().toString(36)}` };
              await storage.save(copy, pageEntry.identity);
              result.imported++;
              break;
            }
          }
        }
      }
      await annotator.refresh();
      return result;
    },

    async exportMarkdown(opts: ExportOptions = {}): Promise<string> {
      const pages = await collectOwnPages(opts.scope ?? "all");
      const sections: string[] = [];
      for (const { identity, annotations } of pages) {
        const active = annotations.filter((a) => !isArchived(a));
        if (!active.length) continue;
        sections.push(pageSection(identity, active));
      }
      // Archived notes read as noise inline, so they land in one trailing section.
      const archived = pages
        .map(({ identity, annotations }) => ({ identity, annotations: annotations.filter(isArchived) }))
        .filter((p) => p.annotations.length);
      if (archived.length) {
        const lines = ["# Archived"];
        for (const { identity, annotations } of archived) {
          lines.push("");
          lines.push(pageSection(identity, annotations, 2));
        }
        sections.push(lines.join("\n"));
      }
      return sections.join("\n\n---\n\n") + "\n";
    },

    createInlineURL(annotation: Annotation, page: PageIdentity): string {
      const payload = JSON.stringify({ v: 1, page, annotation });
      const encoded = base64UrlEncode(payload);
      if (encoded.length > INLINE_MAX_BYTES) {
        throw new Error(`Annotation too large for inline URL (${encoded.length} > ${INLINE_MAX_BYTES} bytes)`);
      }
      return `${page.url.split("#")[0]}#${INLINE_FRAGMENT_PARAM}=${encoded}`;
    },

    parseInlineFragment(hash: string): { page: PageIdentity; annotation: Annotation } | null {
      const raw = hash.startsWith("#") ? hash.slice(1) : hash;
      for (const part of raw.split("&")) {
        const [key, ...rest] = part.split("=");
        if (key !== INLINE_FRAGMENT_PARAM || !rest.length) continue;
        try {
          const payload = JSON.parse(base64UrlDecode(rest.join("=")));
          if (payload?.v === 1 && validateAnnotation(payload.annotation) && payload.page?.id) {
            return { page: payload.page, annotation: payload.annotation };
          }
        } catch {
          return null;
        }
      }
      return null;
    },
  };

  return plugin;
}
