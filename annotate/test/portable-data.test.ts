import { describe, expect, it } from "vitest";
import { createPortableDataPlugin, validateExportDocument } from "../src/plugins/portable-data";
import { createMemoryStorage } from "../src/storage";
import type { Annotation, PageIdentity, PluginContext } from "../src/types";

const page: PageIdentity = { id: "pg_1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", title: "A" };

function makeAnnotation(id: string, updatedAt = 1): Annotation {
  return {
    id,
    pageId: page.id,
    createdAt: 1,
    updatedAt,
    anchor: { url: page.url, textQuote: { exact: "quoted text" } },
    body: { type: "markdown", text: `note ${id}` },
  };
}

function attach(storage = createMemoryStorage()) {
  const plugin = createPortableDataPlugin();
  const registered: string[] = [];
  const ctx = {
    annotator: { refresh: async () => {} } as any,
    storage,
    commands: { register: (name: string) => (registered.push(name), () => {}), execute: () => {}, has: () => false, list: () => [] } as any,
    on: () => () => {},
    addSidebarTab: () => () => {},
    addNoteAction: () => () => {},
    activateSidebarTab: () => {},
    getPage: () => page,
    getNotes: () => [],
    scrollToNote: async () => false,
  } satisfies PluginContext;
  plugin.setup(ctx);
  return { plugin, storage, registered };
}

describe("portable-data plugin", () => {
  it("registers export/import commands", () => {
    const { registered } = attach();
    expect(registered).toEqual(["export.json", "export.markdown", "import.json"]);
  });

  it("round-trips export -> import losslessly", async () => {
    const { plugin, storage } = attach();
    await storage.save(makeAnnotation("a1"), page);
    await storage.save(makeAnnotation("a2"), page);

    const doc = await plugin.exportJSON();
    expect(validateExportDocument(doc)).toBe(true);
    expect(doc.pages[0].annotations).toHaveLength(2);

    const { plugin: plugin2, storage: storage2 } = attach();
    const result = await plugin2.importJSON(JSON.stringify(doc));
    expect(result.imported).toBe(2);
    expect((await storage2.get("a1"))?.body.text).toBe("note a1");
  });

  it("default import strategy skips collisions (non-destructive)", async () => {
    const { plugin, storage } = attach();
    await storage.save({ ...makeAnnotation("a1"), body: { type: "markdown", text: "mine" } }, page);
    const doc = await plugin.exportJSON();
    doc.pages[0].annotations[0].body.text = "theirs";

    const result = await plugin.importJSON(doc);
    expect(result.skipped).toBe(1);
    expect((await storage.get("a1"))?.body.text).toBe("mine");
  });

  it("merge keeps the newer annotation", async () => {
    const { plugin, storage } = attach();
    await storage.save(makeAnnotation("a1", 10), page);
    const incoming = { ...makeAnnotation("a1", 20), body: { type: "markdown" as const, text: "newer" } };
    await plugin.importJSON(
      { format: "wm-annotate-export", schemaVersion: 1, exportedAt: 0, pages: [{ identity: page, annotations: [incoming] }] },
      "merge"
    );
    expect((await storage.get("a1"))?.body.text).toBe("newer");
  });

  it("rejects invalid documents", async () => {
    const { plugin } = attach();
    await expect(plugin.importJSON({ format: "nope" })).rejects.toThrow("Invalid");
    await expect(plugin.importJSON({ format: "wm-annotate-export", schemaVersion: 99, pages: [] })).rejects.toThrow("Invalid");
  });

  it("exports readable markdown", async () => {
    const { plugin, storage } = attach();
    await storage.save(makeAnnotation("a1"), page);
    const md = await plugin.exportMarkdown();
    expect(md).toContain("# A");
    expect(md).toContain("Source: https://example.com/a");
    expect(md).toContain("> quoted text");
    expect(md).toContain("note a1");
  });

  it("creates and parses inline URLs, enforcing max size", () => {
    const { plugin } = attach();
    const annotation = makeAnnotation("a1");
    const url = plugin.createInlineURL(annotation, page);
    expect(url).toContain("#wm=");
    const parsed = plugin.parseInlineFragment(url.split("#")[1] ? `#${url.split("#")[1]}` : "");
    expect(parsed?.annotation.id).toBe("a1");
    expect(parsed?.page.id).toBe(page.id);

    const huge = { ...annotation, body: { type: "markdown" as const, text: "x".repeat(10000) } };
    expect(() => plugin.createInlineURL(huge, page)).toThrow("too large");
  });
});
