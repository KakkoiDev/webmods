// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotator } from "../src/annotator";
import { createGlobalBrowserPlugin, noteLink, searchAnnotations } from "../src/plugins/global-browser";
import type { PageGroup } from "../src/plugins/portable-data";
import { createMemoryStorage } from "../src/storage";
import type { Annotation, AnnotationStorage, Annotator, PageIdentity } from "../src/types";

let annotator: Annotator | null = null;

afterEach(() => {
  annotator?.destroy();
  annotator = null;
  document.body.innerHTML = "";
});

const shadow = () => document.querySelector("[data-wm-annotate-ui]")!.shadowRoot!;

function makePage(id: string, url: string, title?: string): PageIdentity {
  return { id, url, normalizedUrl: url, title };
}

function makeNote(id: string, pageId: string, url: string, text: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    pageId,
    createdAt: 1,
    updatedAt: 1,
    anchor: { url, textQuote: { exact: `quote for ${id}` } },
    body: { type: "markdown", text },
    ...extra,
  };
}

const docsPage = makePage("pg_docs", "https://docs.example.com/auth", "Authentication guide");
const blogPage = makePage("pg_blog", "https://blog.other.dev/caching", "Caching notes");

const fixture: PageGroup[] = [
  {
    identity: docsPage,
    annotations: [
      makeNote("d1", docsPage.id, docsPage.url, "token refresh is unclear", { updatedAt: 100 }),
      makeNote("d2", docsPage.id, docsPage.url, "add a diagram here", { updatedAt: 300 }),
    ],
  },
  {
    identity: blogPage,
    annotations: [makeNote("b1", blogPage.id, blogPage.url, "the cache section needs a token example", { updatedAt: 200 })],
  },
];

describe("searchAnnotations", () => {
  it("returns everything for an empty query", () => {
    expect(searchAnnotations(fixture, "").map((r) => r.annotation.id).sort()).toEqual(["b1", "d1", "d2"]);
    expect(searchAnnotations(fixture, "   ")).toHaveLength(3);
  });

  it("requires every token to match somewhere (AND)", () => {
    expect(searchAnnotations(fixture, "token").map((r) => r.annotation.id).sort()).toEqual(["b1", "d1"]);
    expect(searchAnnotations(fixture, "token cache").map((r) => r.annotation.id)).toEqual(["b1"]);
    expect(searchAnnotations(fixture, "token unicorn")).toHaveLength(0);
  });

  it("matches body, quote, url, and title and reports which field hit first", () => {
    expect(searchAnnotations(fixture, "refresh")[0].matched).toBe("body");
    expect(searchAnnotations(fixture, "quote for d2")[0].matched).toBe("quote");
    expect(searchAnnotations(fixture, "docs.example.com").every((r) => r.matched === "url")).toBe(true);
    expect(searchAnnotations(fixture, "authentication").every((r) => r.matched === "title")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(searchAnnotations(fixture, "TOKEN Refresh").map((r) => r.annotation.id)).toEqual(["d1"]);
  });

  it("filters by site: without treating it as a text token", () => {
    expect(searchAnnotations(fixture, "site:docs.example.com").map((r) => r.annotation.id).sort()).toEqual(["d1", "d2"]);
    expect(searchAnnotations(fixture, "site:other.dev token").map((r) => r.annotation.id)).toEqual(["b1"]);
    expect(searchAnnotations(fixture, "site:nope.example")).toHaveLength(0);
  });

  it("sorts by page URL, then newest first within a page", () => {
    expect(searchAnnotations(fixture, "").map((r) => r.annotation.id)).toEqual(["b1", "d2", "d1"]);
  });
});

describe("noteLink", () => {
  it("builds a single wm-note fragment, replacing any existing hash", () => {
    expect(noteLink(makeNote("n1", "p", "https://example.com/a", "x"))).toBe("https://example.com/a#wm-note=n1");
    expect(noteLink(makeNote("n2", "p", "https://example.com/a?q=1#section", "x"))).toBe(
      "https://example.com/a?q=1#wm-note=n2"
    );
  });
});

describe("global browser plugin", () => {
  async function seed(): Promise<{ storage: AnnotationStorage; a: Annotator }> {
    const storage = createMemoryStorage();
    for (const group of fixture) {
      for (const annotation of group.annotations) await storage.save(annotation, group.identity);
    }
    const a = createAnnotator({ storage });
    annotator = a;
    return { storage, a };
  }

  it("registers the All pages tab and both commands", async () => {
    const { a } = await seed();
    a.use(createGlobalBrowserPlugin());
    expect(a.commands.has("browser.search")).toBe(true);
    expect(a.commands.has("browser.open")).toBe(true);

    a.openSidebar();
    const tabs = [...shadow().querySelectorAll<HTMLElement>(".wm-tab[role=tab]")].map((t) => t.dataset.tabId);
    expect(tabs).toContain("all-pages");
  });

  it("searches across every stored page", async () => {
    const { a } = await seed();
    const plugin = createGlobalBrowserPlugin();
    a.use(plugin);

    expect((await plugin.search("")).length).toBe(3);
    expect((await plugin.search("token")).map((r) => r.annotation.id).sort()).toEqual(["b1", "d1"]);
    expect((await plugin.search("site:other.dev")).map((r) => r.annotation.id)).toEqual(["b1"]);
  });

  it("renders page groups with counts and note rows", async () => {
    const { a } = await seed();
    a.use(createGlobalBrowserPlugin());
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));

    const cards = [...shadow().querySelectorAll(".wm-gb-page")];
    expect(cards).toHaveLength(2);
    expect(shadow().querySelector(".wm-gb-summary")!.textContent).toBe("3 notes on 2 pages");
    expect(shadow().querySelectorAll(".wm-gb-note")).toHaveLength(3);
    expect([...shadow().querySelectorAll(".wm-gb-toggle")].map((t) => t.textContent)).toEqual([
      expect.stringContaining("Caching notes"),
      expect.stringContaining("Authentication guide"),
    ]);
  });

  it("gathers pages of one host under a site section when grouping is on", async () => {
    const { storage, a } = await seed();
    const second = makePage("pg_docs2", "https://docs.example.com/tokens", "Token reference");
    await storage.save(makeNote("d3", second.id, second.url, "expiry is wrong", { updatedAt: 400 }), second);
    a.use(createGlobalBrowserPlugin());
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));

    expect(shadow().querySelectorAll(".wm-gb-site")).toHaveLength(0);
    const toggle = shadow().querySelector<HTMLElement>(".wm-gb-controls [role=switch]")!;
    expect(shadow().querySelector(".wm-gb-controls label")!.textContent).toBe("Group by site");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));

    const sections = [...shadow().querySelectorAll<HTMLElement>(".wm-gb-site")];
    expect(sections.map((s) => s.dataset.host)).toEqual(["blog.other.dev", "docs.example.com"]);
    expect(sections.map((s) => s.querySelectorAll(".wm-gb-page").length)).toEqual([1, 2]);
    expect(sections[1].querySelector(".wm-gb-site-count")!.textContent).toBe("3 notes on 2 pages");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // Collapsing a site hides its pages but keeps its header.
    sections[1].querySelector<HTMLElement>(".wm-gb-site-head")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await new Promise((r) => setTimeout(r, 50));
    const after = [...shadow().querySelectorAll<HTMLElement>(".wm-gb-site")];
    expect(after[1].querySelector(".wm-gb-site-head")!.getAttribute("aria-expanded")).toBe("false");
    expect(after[1].querySelectorAll(".wm-gb-page")).toHaveLength(0);
    expect(after[0].querySelectorAll(".wm-gb-page")).toHaveLength(1);
  });

  it("keeps the grouping choice across a tab remount", async () => {
    const { a } = await seed();
    a.use(createGlobalBrowserPlugin());
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));
    shadow()
      .querySelector<HTMLElement>(".wm-gb-controls [role=switch]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(shadow().querySelectorAll(".wm-gb-site")).toHaveLength(2);

    const notesTab = [...shadow().querySelectorAll<HTMLElement>(".wm-tab[role=tab]")].find((t) => t.dataset.tabId === "notes")!;
    notesTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));

    expect(shadow().querySelector<HTMLElement>(".wm-gb-controls [role=switch]")!.getAttribute("aria-checked")).toBe("true");
    expect(shadow().querySelectorAll(".wm-gb-site")).toHaveLength(2);
  });

  it("degrades to a message when the adapter cannot list all pages", async () => {
    const inner = createMemoryStorage();
    const limited: AnnotationStorage = {
      getPage: (p) => inner.getPage(p),
      get: (id) => inner.get(id),
      save: (a, p) => inner.save(a, p),
      delete: (id) => inner.delete(id),
    };
    const a = createAnnotator({ storage: limited });
    annotator = a;
    const plugin = createGlobalBrowserPlugin();
    a.use(plugin);

    expect(await plugin.search("anything")).toEqual([]);
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));
    expect(shadow().querySelector(".wm-gb-empty")!.textContent).toMatch(/does not support browsing all pages/);
  });

  it("re-renders when a note is deleted", async () => {
    const { a } = await seed();
    a.use(createGlobalBrowserPlugin());
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));
    expect(shadow().querySelectorAll(".wm-gb-note")).toHaveLength(3);

    await a.deleteNote("d1");
    await new Promise((r) => setTimeout(r, 80));
    expect(shadow().querySelectorAll(".wm-gb-note")).toHaveLength(2);
    expect(shadow().querySelector(".wm-gb-summary")!.textContent).toBe("2 notes on 2 pages");
  });

  it("stops re-rendering after the tab unmounts", async () => {
    const { a } = await seed();
    a.use(createGlobalBrowserPlugin());
    a.commands.execute("browser.open");
    await new Promise((r) => setTimeout(r, 50));

    a.closeSidebar();
    a.openSidebar();
    // Back on the Notes tab: the All pages list is gone, and a delete must not throw.
    expect(shadow().querySelectorAll(".wm-gb-page")).toHaveLength(0);
    await expect(a.deleteNote("d2")).resolves.toBeUndefined();
  });
});
