import { describe, expect, it } from "vitest";
import {
  FIRSTMATE_SENT_SETTING,
  buildFirstmatePayload,
  createFirstmatePlugin,
  firstmateFilename,
  localPathOf,
  unsentNotes,
} from "../src/plugins/firstmate";
import { ARCHIVED_KEY } from "../src/archive";
import { createMemoryStorage } from "../src/storage";
import type { Annotation, HeaderAction, PageIdentity, PluginContext } from "../src/types";

const docPage: PageIdentity = {
  id: "pg_doc",
  url: "file:///Users/me/work/plan%20v2.html",
  normalizedUrl: "file:///Users/me/work/plan%20v2.html",
  title: "Plan v2",
};
const webPage: PageIdentity = {
  id: "pg_web",
  url: "https://example.com/a",
  normalizedUrl: "https://example.com/a",
};

function note(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    pageId: docPage.id,
    createdAt: 1_000,
    updatedAt: 2_000,
    anchor: { url: docPage.url, selector: `#${id}`, textQuote: { exact: `quote ${id}`, prefix: "pre", suffix: "suf" } },
    body: { type: "markdown", text: `body ${id}` },
    ...over,
  };
}

function attach(opts: { failSave?: boolean; now?: number } = {}) {
  const storage = createMemoryStorage();
  const saved: Array<{ filename: string; text: string }> = [];
  const notices: string[] = [];
  const headerActions: HeaderAction[] = [];
  const registered: string[] = [];
  const plugin = createFirstmatePlugin({
    save: async (filename, text) => {
      if (opts.failSave) throw new Error("disk full");
      saved.push({ filename, text });
    },
    notify: (m) => notices.push(m),
    now: () => opts.now ?? Date.UTC(2026, 8, 28, 3, 20, 53, 123),
  });
  const ctx = {
    annotator: {} as any,
    storage,
    commands: { register: (name: string) => (registered.push(name), () => {}), execute: () => {}, has: () => false, list: () => [] } as any,
    on: () => () => {},
    addSidebarTab: () => () => {},
    addNoteAction: () => () => {},
    addHeaderAction: (a: HeaderAction) => (headerActions.push(a), () => {}),
    activateSidebarTab: () => {},
    getPage: () => docPage,
    getNotes: () => [],
    scrollToNote: async () => false,
  } satisfies PluginContext;
  plugin.setup(ctx);
  return { plugin, storage, saved, notices, headerActions, registered };
}

describe("firstmate serializer", () => {
  it("serializes page identity, local path, anchors, bodies and timestamps", () => {
    const payload = buildFirstmatePayload(
      docPage,
      [note("b", { createdAt: 3_000, updatedAt: 3_000 }), note("a", { anchor: { url: docPage.url, kind: "range", textQuote: { exact: "picked" } } })],
      Date.UTC(2026, 8, 28)
    );
    expect(payload).toEqual({
      format: "wm-annotate-firstmate",
      schemaVersion: 1,
      sentAt: "2026-09-28T00:00:00.000Z",
      page: { url: docPage.url, title: "Plan v2", localPath: "/Users/me/work/plan v2.html" },
      notes: [
        {
          id: "a",
          anchor: { kind: "range", selector: null, quote: "picked", prefix: null, suffix: null },
          body: "body a",
          createdAt: "1970-01-01T00:00:01.000Z",
          updatedAt: "1970-01-01T00:00:02.000Z",
        },
        {
          id: "b",
          anchor: { kind: "block", selector: "#b", quote: "quote b", prefix: "pre", suffix: "suf" },
          body: "body b",
          createdAt: "1970-01-01T00:00:03.000Z",
          updatedAt: "1970-01-01T00:00:03.000Z",
        },
      ],
    });
  });

  it("gives a local path only for file:// pages", () => {
    expect(localPathOf("file:///tmp/x.html")).toBe("/tmp/x.html");
    expect(localPathOf(webPage.url)).toBeNull();
    expect(buildFirstmatePayload(webPage, [], 0).page).toEqual({ url: webPage.url, title: null, localPath: null });
  });

  it("names the file with a colon-free ISO timestamp", () => {
    expect(firstmateFilename(Date.UTC(2026, 8, 28, 3, 20, 53, 123))).toBe("firstmate-annotate-20260928T032053.123Z.json");
  });
});

describe("unsentNotes", () => {
  it("keeps never-sent and edited-since-sent notes, drops sent and archived ones", () => {
    const notes = [
      note("new"),
      note("sent", { updatedAt: 2_000 }),
      note("edited", { updatedAt: 5_000 }),
      note("archived", { metadata: { [ARCHIVED_KEY]: 9 } }),
    ];
    expect(unsentNotes(notes, { sent: 2_000, edited: 2_000 }).map((n) => n.id)).toEqual(["new", "edited"]);
  });
});

describe("firstmate plugin", () => {
  it("registers the command and a sidebar header button", () => {
    const { registered, headerActions } = attach();
    expect(registered).toEqual(["firstmate.send"]);
    expect(headerActions.map((a) => [a.id, a.label])).toEqual([["firstmate", "Send to firstmate"]]);
  });

  it("saves only the current page's unsent notes, then marks them sent", async () => {
    const { plugin, storage, saved } = attach();
    await storage.save(note("n1"), docPage);
    await storage.save({ ...note("w1"), pageId: webPage.id }, webPage);

    const first = await plugin.send();
    expect(first).toEqual({ sent: 1, filename: "firstmate-annotate-20260928T032053.123Z.json" });
    expect(JSON.parse(saved[0].text).notes.map((n: { id: string }) => n.id)).toEqual(["n1"]);
    expect(await storage.getSetting?.(FIRSTMATE_SENT_SETTING)).toEqual({ n1: 2_000 });

    expect(await plugin.send()).toEqual({ sent: 0, filename: null });
    expect(saved).toHaveLength(1);

    await storage.save(note("n2"), docPage);
    await plugin.send();
    expect(JSON.parse(saved[1].text).notes.map((n: { id: string }) => n.id)).toEqual(["n2"]);
  });

  it("leaves notes unsent when the save fails", async () => {
    const { plugin, storage } = attach({ failSave: true });
    await storage.save(note("n1"), docPage);
    await expect(plugin.send()).rejects.toThrow("disk full");
    expect(await storage.getSetting?.(FIRSTMATE_SENT_SETTING)).toBeUndefined();
  });

  it("reports the outcome from the header button", async () => {
    const { storage, headerActions, notices } = attach();
    await storage.save(note("n1"), docPage);
    headerActions[0].onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    headerActions[0].onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(notices).toEqual([
      "Sent 1 note to firstmate as firstmate-annotate-20260928T032053.123Z.json (browser download folder).",
      "No new or edited notes on this page to send to firstmate.",
    ]);
  });
});
