import { beforeEach, describe, expect, it } from "vitest";
import { createLocalStorageStorage, createMemoryStorage, migrateDB, emptyDB } from "../src/storage";
import type { Annotation, PageIdentity } from "../src/types";

const page: PageIdentity = {
  id: "pg_test",
  url: "https://example.com/a",
  normalizedUrl: "https://example.com/a",
  title: "Test",
};

function makeAnnotation(id: string, pageId = page.id): Annotation {
  return {
    id,
    pageId,
    createdAt: 1,
    updatedAt: 1,
    anchor: { url: page.url },
    body: { type: "markdown", text: `note ${id}` },
  };
}

for (const [name, factory] of [
  ["MemoryStorage", createMemoryStorage],
  ["LocalStorageStorage", () => createLocalStorageStorage("wm-test")],
] as const) {
  describe(name, () => {
    beforeEach(() => localStorage.clear());

    it("saves, gets, lists, and deletes annotations", async () => {
      const storage = factory();
      await storage.save(makeAnnotation("a1"), page);
      await storage.save(makeAnnotation("a2"), page);

      expect((await storage.getPage(page)).map((a) => a.id)).toEqual(["a1", "a2"]);
      expect((await storage.get("a1"))?.body.text).toBe("note a1");
      expect(await storage.get("missing")).toBeNull();

      const pages = await storage.listPages();
      expect(pages).toEqual([{ page, count: 2 }]);
      expect((await storage.listAll()).length).toBe(2);

      await storage.delete("a1");
      expect((await storage.getPage(page)).map((a) => a.id)).toEqual(["a2"]);
    });

    it("updates in place on same-id save", async () => {
      const storage = factory();
      await storage.save(makeAnnotation("a1"), page);
      await storage.save({ ...makeAnnotation("a1"), body: { type: "markdown", text: "edited" } }, page);
      const notes = await storage.getPage(page);
      expect(notes).toHaveLength(1);
      expect(notes[0].body.text).toBe("edited");
    });

    it("round-trips settings without touching annotations", async () => {
      const storage = factory();
      await storage.save(makeAnnotation("a1"), page);
      expect(await storage.getSetting("chat.apiKey")).toBeUndefined();

      await storage.setSetting("chat.apiKey", "sk-secret");
      await storage.setSetting("chat.model", "claude-sonnet-5");
      expect(await storage.getSetting("chat.apiKey")).toBe("sk-secret");
      expect(await storage.getSetting("chat.model")).toBe("claude-sonnet-5");
      // settings and annotations live side by side
      expect(await storage.getPage(page)).toHaveLength(1);
    });
  });
}

describe("LocalStorageStorage settings persistence", () => {
  it("survives adapter re-creation", async () => {
    localStorage.clear();
    await createLocalStorageStorage("wm-test").setSetting("ui.theme", "dark");
    expect(await createLocalStorageStorage("wm-test").getSetting("ui.theme")).toBe("dark");
  });
});

describe("LocalStorageStorage persistence", () => {
  it("survives adapter re-creation (reload simulation)", async () => {
    localStorage.clear();
    const first = createLocalStorageStorage("wm-test");
    await first.save(makeAnnotation("a1"), page);
    const second = createLocalStorageStorage("wm-test");
    expect((await second.get("a1"))?.id).toBe("a1");
  });
});

describe("migrateDB", () => {
  it("recovers from garbage", () => {
    expect(migrateDB(null)).toEqual(emptyDB());
    expect(migrateDB("junk")).toEqual(emptyDB());
    expect(migrateDB({ pages: null })).toEqual(emptyDB());
  });

  it("stamps the current schema version", () => {
    const db = migrateDB({ schemaVersion: 0, pages: {} });
    expect(db.schemaVersion).toBe(1);
  });
});
