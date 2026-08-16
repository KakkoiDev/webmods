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
  });
}

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
