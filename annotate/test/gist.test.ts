import { describe, expect, it } from "vitest";
import { GIST_FILENAME, GIST_TOKEN_SETTING, GIST_URL_SETTING, createGistPlugin, parseGistId } from "../src/plugins/gist";
import { createMemoryStorage } from "../src/storage";
import type { Annotation, AnnotationStorage, HeaderAction, PageIdentity, PluginContext } from "../src/types";

const page: PageIdentity = {
  id: "pg_1",
  url: "https://app.notion.com/task-1",
  normalizedUrl: "https://app.notion.com/task-1",
  title: "Order data model",
};
const otherHost: PageIdentity = {
  id: "pg_2",
  url: "https://docs.stripe.com/webhooks",
  normalizedUrl: "https://docs.stripe.com/webhooks",
  title: "Webhooks",
};

function makeNote(id: string, owner: PageIdentity): Annotation {
  return {
    id,
    pageId: owner.id,
    createdAt: 1,
    updatedAt: 1,
    anchor: { url: owner.url, textQuote: { exact: `quote ${id}` } },
    body: { type: "markdown", text: `note ${id}` },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

function attach(
  overrides: {
    responses?: Array<{ status: number; payload: unknown }>;
    answers?: Array<string | null>;
    storage?: AnnotationStorage;
  } = {}
) {
  const calls: Call[] = [];
  const notices: string[] = [];
  const asked: string[] = [];
  const answers = [...(overrides.answers ?? [])];
  const responses = [...(overrides.responses ?? [{ status: 201, payload: { id: "abc", html_url: "https://gist.github.com/me/abcdef0123456789abcd" } }])];

  const plugin = createGistPlugin({
    fetchFn: (async (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      const next = responses.shift() ?? { status: 500, payload: { message: "no stubbed response" } };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.payload,
      } as Response;
    }) as unknown as typeof fetch,
    prompt: (message) => {
      asked.push(message);
      return answers.length ? answers.shift()! : null;
    },
    notify: (message) => notices.push(message),
  });

  const storage = overrides.storage ?? createMemoryStorage();
  const headerActions: HeaderAction[] = [];
  const registered: string[] = [];
  const ctx = {
    annotator: { refresh: async () => {} } as any,
    storage,
    commands: { register: (name: string) => (registered.push(name), () => {}), execute: () => {}, has: () => false, list: () => [] } as any,
    on: () => () => {},
    addSidebarTab: () => () => {},
    addNoteAction: () => () => {},
    addHeaderAction: (action: HeaderAction) => (headerActions.push(action), () => {}),
    activateSidebarTab: () => {},
    getPage: () => page,
    getNotes: () => [],
    scrollToNote: async () => false,
  } satisfies PluginContext;
  plugin.setup(ctx);
  return { plugin, storage, calls, notices, asked, headerActions, registered };
}

async function seed(storage: AnnotationStorage): Promise<void> {
  await storage.save(makeNote("a1", page), page);
  await storage.save(makeNote("a2", page), page);
  await storage.save(makeNote("b1", otherHost), otherHost);
}

describe("parseGistId", () => {
  it("accepts the shapes a user is likely to paste", () => {
    const id = "abcdef0123456789abcd";
    expect(parseGistId(`https://gist.github.com/me/${id}`)).toBe(id);
    expect(parseGistId(`https://gist.github.com/${id}`)).toBe(id);
    expect(parseGistId(`https://api.github.com/gists/${id}`)).toBe(id);
    expect(parseGistId(id)).toBe(id);
    expect(parseGistId(`  https://gist.github.com/me/${id}  `)).toBe(id);
  });

  it("rejects anything else", () => {
    expect(parseGistId("")).toBeNull();
    expect(parseGistId(null)).toBeNull();
    expect(parseGistId("https://github.com/KakkoiDev/webmods")).toBeNull();
    expect(parseGistId("https://gist.github.com/me/short")).toBeNull();
    expect(parseGistId("not a url")).toBeNull();
  });
});

describe("gist plugin", () => {
  it("registers its command and a Gist header dropdown", () => {
    const { registered, headerActions } = attach();
    expect(registered).toEqual(["gist.upload"]);
    expect(headerActions.map((a) => a.id)).toEqual(["gist"]);
    expect(headerActions[0].items!().map((i) => i.group ?? i.label)).toEqual([
      "Upload to a secret gist",
      "This site (app.notion.com)",
      "All sites",
      "Settings",
      "GitHub token…",
      "Target gist…",
    ]);
  });

  it("creates a secret gist scoped to this site and remembers its URL", async () => {
    const { plugin, storage, calls } = attach();
    await storage.setSetting!(GIST_TOKEN_SETTING, "ghp_test");
    await seed(storage);

    const result = await plugin.upload("site");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/gists");
    expect(calls[0].headers.authorization).toBe("Bearer ghp_test");
    expect(calls[0].body.public).toBe(false);
    expect(calls[0].body.description).toBe("webmods annotate: app.notion.com, 2 notes on 1 page");

    const doc = JSON.parse(calls[0].body.files[GIST_FILENAME].content);
    expect(doc.format).toBe("wm-annotate-export");
    expect(doc.pages.flatMap((p: { annotations: Annotation[] }) => p.annotations.map((n) => n.id)).sort()).toEqual(["a1", "a2"]);

    expect(result).toMatchObject({ created: true, notes: 2, pages: 1, id: "abc" });
    // Stored, so the next upload updates this gist instead of creating another.
    expect(await storage.getSetting!(GIST_URL_SETTING)).toBe("https://gist.github.com/me/abcdef0123456789abcd");
  });

  it("uploads every site when the scope says so", async () => {
    const { plugin, storage, calls } = attach();
    await storage.setSetting!(GIST_TOKEN_SETTING, "ghp_test");
    await seed(storage);

    await plugin.upload("all");
    const doc = JSON.parse(calls[0].body.files[GIST_FILENAME].content);
    expect(doc.pages.flatMap((p: { annotations: Annotation[] }) => p.annotations.map((n) => n.id)).sort()).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
  });

  it("PATCHes the stored gist on the next upload", async () => {
    const id = "abcdef0123456789abcd";
    const { plugin, storage, calls } = attach({
      responses: [
        { status: 201, payload: { id: "abc", html_url: `https://gist.github.com/me/${id}` } },
        { status: 200, payload: { id: "abc", html_url: `https://gist.github.com/me/${id}` } },
      ],
    });
    await storage.setSetting!(GIST_TOKEN_SETTING, "ghp_test");
    await seed(storage);

    await plugin.upload("site");
    const second = await plugin.upload("site");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.github.com/gists",
      `PATCH https://api.github.com/gists/${id}`,
    ]);
    expect(second.created).toBe(false);
  });

  it("uploads to an explicitly given gist URL", async () => {
    const id = "0123456789abcdef0123";
    const { plugin, storage, calls } = attach({
      responses: [{ status: 200, payload: { id: "given", html_url: `https://gist.github.com/me/${id}` } }],
    });
    await storage.setSetting!(GIST_TOKEN_SETTING, "ghp_test");
    await storage.setSetting!(GIST_URL_SETTING, "https://gist.github.com/me/aaaaaaaaaaaaaaaaaaaa");
    await seed(storage);

    await plugin.upload("site", { url: `https://gist.github.com/me/${id}` });
    expect(calls[0].url).toBe(`https://api.github.com/gists/${id}`);
    expect(calls[0].method).toBe("PATCH");
  });

  it("asks for a token once and stores it", async () => {
    const { plugin, storage, calls, asked } = attach({ answers: ["  ghp_typed  "] });
    await seed(storage);

    await plugin.upload("site");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("gist scope");
    expect(calls[0].headers.authorization).toBe("Bearer ghp_typed");
    expect(await storage.getSetting!(GIST_TOKEN_SETTING)).toBe("ghp_typed");
  });

  it("refuses to upload when no token is given", async () => {
    const { plugin, storage, calls } = attach({ answers: [null] });
    await seed(storage);
    await expect(plugin.upload("site")).rejects.toThrow("token with the gist scope is required");
    expect(calls).toHaveLength(0);
  });

  it("reports what GitHub said when it refuses", async () => {
    const id = "abcdef0123456789abcd";
    const { plugin, storage } = attach({
      responses: [
        { status: 401, payload: { message: "Bad credentials" } },
        { status: 404, payload: { message: "Not Found" } },
      ],
    });
    await storage.setSetting!(GIST_TOKEN_SETTING, "ghp_test");
    await seed(storage);

    await expect(plugin.upload("site")).rejects.toThrow("GitHub rejected the token (401): Bad credentials");
    await storage.setSetting!(GIST_URL_SETTING, `https://gist.github.com/me/${id}`);
    await expect(plugin.upload("site")).rejects.toThrow(`Gist ${id} not found`);
  });

  it("never writes the token into the uploaded document", async () => {
    const { plugin, storage, calls } = attach();
    await storage.setSetting!(GIST_TOKEN_SETTING, "ghp_secret_value");
    await seed(storage);
    await plugin.upload("all");
    expect(calls[0].body.files[GIST_FILENAME].content).not.toContain("ghp_secret_value");
  });
});
