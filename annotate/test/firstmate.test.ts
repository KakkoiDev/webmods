import { afterEach, describe, expect, it } from "vitest";
import {
  FIRSTMATE_CONFIG_FILENAME,
  FIRSTMATE_PORT_SETTING,
  FIRSTMATE_ROOT_SETTING,
  FIRSTMATE_SENT_SETTING,
  buildFirstmatePayload,
  createFirstmatePlugin,
  firstmateFilename,
  localPathOf,
  parsePort,
  reloadEventsURL,
  unsentNotes,
} from "../src/plugins/firstmate";
import { gmSave } from "../src/userscript";
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

function attach(opts: { failSave?: boolean; now?: number; answers?: Array<string | null>; page?: PageIdentity } = {}) {
  const storage = createMemoryStorage();
  const saved: Array<{ path: string; text: string; overwrite: boolean }> = [];
  const notices: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const headerActions: HeaderAction[] = [];
  const registered: string[] = [];
  const plugin = createFirstmatePlugin({
    save: async (path, text, { overwrite }) => {
      if (opts.failSave) throw new Error("disk full");
      saved.push({ path, text, overwrite });
    },
    notify: (m) => notices.push(m),
    prompt: () => (answers.length ? answers.shift()! : null),
    now: () => opts.now ?? Date.UTC(2026, 8, 28, 3, 20, 53, 123),
    request: false,
  });
  const ctx = {
    annotator: {} as any,
    storage,
    commands: { register: (name: string) => (registered.push(name), () => {}), execute: () => {}, has: () => false, list: () => [] } as any,
    on: () => () => {},
    addSidebarTab: () => () => {},
    addNoteAction: () => () => {},
    addHeaderAction: (a: HeaderAction) => (headerActions.push(a), () => {}),
    addNoteSection: () => () => {},
    addStatusItem: () => () => {},
    activateSidebarTab: () => {},
    getPage: () => opts.page ?? docPage,
    getNotes: () => [],
    scrollToNote: async () => false,
  } satisfies PluginContext;
  plugin.setup(ctx);
  return { plugin, storage, saved, notices, headerActions, registered };
}

describe("gmSave", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).GM_download;
    delete (globalThis as Record<string, unknown>).GM_info;
  });

  it("blames a missing GM_download grant, not the download mode, even when the mode is already browser", async () => {
    delete (globalThis as Record<string, unknown>).GM_download;
    (globalThis as Record<string, unknown>).GM_info = { downloadMode: "browser" };

    await expect(gmSave("a.json", "{}", { overwrite: false })).rejects.toThrow(
      /GM_download is not available.*@grant GM_download/s
    );
  });

  it("blames the download mode once GM_download is granted", async () => {
    (globalThis as Record<string, unknown>).GM_download = () => {};
    (globalThis as Record<string, unknown>).GM_info = { downloadMode: "native" };

    await expect(gmSave("a.json", "{}", { overwrite: false })).rejects.toThrow(/download mode is "native"/);
  });
});

describe("firstmate serializer", () => {
  it("serializes page identity, local path, anchors, bodies and timestamps", () => {
    const payload = buildFirstmatePayload(
      docPage,
      [note("b", { createdAt: 3_000, updatedAt: 3_000 }), note("a", { anchor: { url: docPage.url, kind: "range", textQuote: { exact: "picked" } } })],
      Date.UTC(2026, 8, 28),
      "firstmate-annotate/file/users-me-work-plan-v2.html"
    );
    expect(payload).toEqual({
      format: "wm-annotate-firstmate",
      schemaVersion: 1,
      sentAt: "2026-09-28T00:00:00.000Z",
      folder: "firstmate-annotate/file/users-me-work-plan-v2.html",
      page: { url: docPage.url, title: "Plan v2", localPath: "/Users/me/work/plan v2.html" },
      notes: [
        {
          id: "a",
          anchor: { kind: "range", selector: null, quote: "picked", prefix: null, suffix: null },
          body: "body a",
          replies: [],
          createdAt: "1970-01-01T00:00:01.000Z",
          updatedAt: "1970-01-01T00:00:02.000Z",
        },
        {
          id: "b",
          anchor: { kind: "block", selector: "#b", quote: "quote b", prefix: "pre", suffix: "suf" },
          body: "body b",
          replies: [],
          createdAt: "1970-01-01T00:00:03.000Z",
          updatedAt: "1970-01-01T00:00:03.000Z",
        },
      ],
    });
  });

  it("gives a local path only for file:// pages", () => {
    expect(localPathOf("file:///tmp/x.html")).toBe("/tmp/x.html");
    expect(localPathOf(webPage.url)).toBeNull();
    expect(buildFirstmatePayload(webPage, [], 0, "f").page).toEqual({ url: webPage.url, title: null, localPath: null });
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
  const payloadPath = "firstmate-annotate/example.com/a/firstmate-annotate-20260928T032053.123Z.json";

  it("registers its commands and a Firstmate header dropdown", () => {
    const { registered, headerActions } = attach();
    expect(registered).toEqual(["firstmate.send", "firstmate.configure-root", "firstmate.configure-port"]);
    expect(headerActions.map((a) => a.id)).toEqual(["firstmate"]);
    expect(headerActions[0].items?.().map((i) => i.label ?? i.group)).toEqual(["Send to firstmate", "Settings", "Folder…", "Reload port…"]);
  });

  it("saves only the current page's unsent notes into the per-URL folder, then marks them sent", async () => {
    const { plugin, storage, saved } = attach({ page: webPage });
    await storage.save({ ...note("n1"), pageId: webPage.id }, webPage);
    await storage.save(note("d1"), docPage);

    const first = await plugin.send();
    expect(first).toEqual({ sent: 1, path: payloadPath });
    expect(saved.map((s) => [s.path, s.overwrite])).toEqual([
      [FIRSTMATE_CONFIG_FILENAME, true],
      [payloadPath, false],
    ]);
    expect(JSON.parse(saved[0].text)).toEqual({ format: "wm-annotate-firstmate-config", root: "firstmate-annotate", reloadPort: 4817 });
    const payload = JSON.parse(saved[1].text);
    expect(payload.folder).toBe("firstmate-annotate/example.com/a");
    expect(payload.notes.map((n: { id: string }) => n.id)).toEqual(["n1"]);
    expect(await storage.getSetting?.(FIRSTMATE_SENT_SETTING)).toEqual({ n1: 2_000 });

    expect(await plugin.send()).toEqual({ sent: 0, path: null });
    expect(saved).toHaveLength(2);

    await storage.save({ ...note("n2"), pageId: webPage.id }, webPage);
    await plugin.send();
    expect(JSON.parse(saved[3].text).notes.map((n: { id: string }) => n.id)).toEqual(["n2"]);
  });

  it("uses the configured root for the folder and the config file", async () => {
    const { plugin, storage, saved } = attach({ page: webPage });
    await storage.setSetting?.(FIRSTMATE_ROOT_SETTING, "fm/inbox");
    await storage.save({ ...note("n1"), pageId: webPage.id }, webPage);
    expect((await plugin.send()).path).toBe("fm/inbox/example.com/a/firstmate-annotate-20260928T032053.123Z.json");
    expect(JSON.parse(saved[0].text).root).toBe("fm/inbox");
  });

  it("files a served doc's notes next to the doc, like its file:// copy", async () => {
    const served: PageIdentity = { id: "pg_served", url: "http://127.0.0.1:4817/doc/docs/plan.html", normalizedUrl: "http://127.0.0.1:4817/doc/docs/plan.html" };
    const { plugin, storage } = attach({ page: served });
    await storage.save({ ...note("n1"), pageId: served.id }, served);
    expect((await plugin.send()).path).toBe("firstmate-annotate/docs/firstmate-annotate-20260928T032053.123Z.json");
  });

  it("leaves notes unsent when the save fails", async () => {
    const { plugin, storage } = attach({ failSave: true });
    await storage.save(note("n1"), docPage);
    await expect(plugin.send()).rejects.toThrow("disk full");
    expect(await storage.getSetting?.(FIRSTMATE_SENT_SETTING)).toBeUndefined();
  });

  it("stores a valid folder from the dropdown and refuses traversal", async () => {
    const ok = attach({ answers: ["team/notes"] });
    ok.headerActions[0].items?.()[2].onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(await ok.storage.getSetting?.(FIRSTMATE_ROOT_SETTING)).toBe("team/notes");

    const bad = attach({ answers: ["../etc"] });
    bad.headerActions[0].items?.()[2].onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(await bad.storage.getSetting?.(FIRSTMATE_ROOT_SETTING)).toBeUndefined();
    expect(bad.notices[0]).toContain('must not contain ".."');
  });

  it("reports the outcome from the dropdown", async () => {
    const { storage, headerActions, notices } = attach({ page: webPage });
    await storage.save({ ...note("n1"), pageId: webPage.id }, webPage);
    headerActions[0].items?.()[0].onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    headerActions[0].items?.()[0].onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(notices).toEqual([
      `Sent 1 note to firstmate: Downloads/${payloadPath}`,
      "No new or edited notes on this page to send to firstmate.",
    ]);
  });
});

describe("live reload", () => {
  async function setupFor(url: string, settings: Record<string, unknown> = {}) {
    const storage = createMemoryStorage();
    for (const [key, value] of Object.entries(settings)) await storage.setSetting?.(key, value);
    const connected: string[] = [];
    const listeners: Array<() => void> = [];
    let closed = 0;
    let reloads = 0;
    const plugin = createFirstmatePlugin({
      save: async () => {},
      request: false,
      liveReload: {
        connect: (u) => {
          connected.push(u);
          return { addEventListener: (_t, l) => void listeners.push(l), close: () => void closed++ };
        },
        reload: () => void reloads++,
      },
    });
    const page: PageIdentity = { id: "p", url, normalizedUrl: url };
    plugin.setup({
      annotator: {} as any,
      storage,
      commands: { register: () => () => {} } as any,
      on: () => () => {},
      addSidebarTab: () => () => {},
      addNoteAction: () => () => {},
      addHeaderAction: () => () => {},
      addNoteSection: () => () => {},
      addStatusItem: () => () => {},
      activateSidebarTab: () => {},
      getPage: () => page,
      getNotes: () => [],
      scrollToNote: async () => false,
    });
    await new Promise((r) => setTimeout(r, 0));
    return {
      plugin,
      connected,
      fire: () => listeners.forEach((l) => l()),
      reloads: () => reloads,
      closed: () => closed,
    };
  }

  it("subscribes a file:// doc under the root and reloads on the reload event", async () => {
    const lr = await setupFor("file:///Users/me/Downloads/firstmate-annotate/docs/plan/doc.html");
    expect(lr.connected).toEqual([
      "http://127.0.0.1:4817/events?path=%2FUsers%2Fme%2FDownloads%2Ffirstmate-annotate%2Fdocs%2Fplan%2Fdoc.html",
    ]);
    lr.fire();
    expect(lr.reloads()).toBe(1);
    lr.plugin.destroy?.();
    expect(lr.closed()).toBe(1);
  });

  it("uses the configured port and root", async () => {
    const lr = await setupFor("file:///d/team/notes/x/doc.html", {
      [FIRSTMATE_PORT_SETTING]: 5000,
      [FIRSTMATE_ROOT_SETTING]: "team/notes",
    });
    expect(lr.connected).toEqual([reloadEventsURL(5000, "/d/team/notes/x/doc.html")]);
  });

  it("subscribes a doc served from 127.0.0.1 by its path under the root", async () => {
    const lr = await setupFor("http://127.0.0.1:4817/doc/docs/plan%20v2.html");
    expect(lr.connected).toEqual(["http://127.0.0.1:4817/events?doc=docs%2Fplan%20v2.html"]);
  });

  it("does not subscribe web pages or local files outside the root", async () => {
    expect((await setupFor("https://example.com/doc.html")).connected).toEqual([]);
    expect((await setupFor("file:///Users/me/elsewhere/doc.html")).connected).toEqual([]);
  });

  it("validates the port", () => {
    expect(parsePort("")).toBe(4817);
    expect(parsePort("5000")).toBe(5000);
    expect(() => parsePort("80")).toThrow("1024-65535");
    expect(() => parsePort("abc")).toThrow("1024-65535");
  });
});
