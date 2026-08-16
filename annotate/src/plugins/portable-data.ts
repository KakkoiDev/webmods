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

export interface PortableDataAPI {
  exportJSON(): Promise<ExportDocument>;
  importJSON(data: unknown, strategy?: CollisionStrategy): Promise<ImportResult>;
  exportMarkdown(): Promise<string>;
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

export function createPortableDataPlugin(): PortableDataPlugin {
  let ctx: PluginContext | null = null;

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("portable-data plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  async function collectOwnPages(): Promise<ExportDocument["pages"]> {
    const { storage, getPage } = requireCtx();
    return collectPages(storage, getPage());
  }

  const plugin: PortableDataPlugin = {
    name: "portable-data",

    setup(pluginCtx) {
      ctx = pluginCtx;
      pluginCtx.commands.register("export.json", () => plugin.exportJSON());
      pluginCtx.commands.register("export.markdown", () => plugin.exportMarkdown());
      pluginCtx.commands.register("import.json", (data) => plugin.importJSON(data));
    },

    destroy() {
      ctx = null;
    },

    async exportJSON(): Promise<ExportDocument> {
      return {
        format: "wm-annotate-export",
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        pages: await collectOwnPages(),
      };
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

    async exportMarkdown(): Promise<string> {
      const pages = await collectOwnPages();
      const sections: string[] = [];
      for (const { identity, annotations } of pages) {
        if (!annotations.length) continue;
        const lines: string[] = [];
        lines.push(`# ${identity.title || identity.normalizedUrl}`);
        lines.push("");
        lines.push(`Source: ${identity.url}`);
        for (const a of [...annotations].sort((x, y) => x.createdAt - y.createdAt)) {
          lines.push("");
          const heading = a.anchor.fingerprint?.nearbyHeading || a.anchor.textQuote?.exact?.slice(0, 60) || "Note";
          lines.push(`## ${heading}`);
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
