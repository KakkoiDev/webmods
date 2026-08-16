// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnnotator } from "../src/annotator";
import { createAnchor } from "../src/anchors";
import { createChatPlugin, createEchoProvider, type ChatPlugin, type ChatProvider } from "../src/plugins/chat";
import { createPortableDataPlugin } from "../src/plugins/portable-data";
import { createMemoryStorage } from "../src/storage";
import type { Annotator } from "../src/types";

let annotator: Annotator | null = null;

afterEach(() => {
  annotator?.destroy();
  annotator = null;
  document.body.innerHTML = "";
});

const shadow = () => document.querySelector("[data-wm-annotate-ui]")!.shadowRoot!;

function attach(provider: ChatProvider): { annotator: Annotator; plugin: ChatPlugin } {
  const a = createAnnotator({ storage: createMemoryStorage() });
  const plugin = createChatPlugin({ provider });
  a.use(plugin);
  annotator = a;
  return { annotator: a, plugin };
}

async function seedNote(a: Annotator, text = "why is this here?"): Promise<string> {
  document.body.innerHTML = `
    <section>
      <p id="before">Preceding paragraph for surrounding context.</p>
      <p id="t">Authentication is handled by the session service and refresh tokens.</p>
      <p id="after">Following paragraph for surrounding context.</p>
    </section>`;
  const anchor = createAnchor(document.getElementById("t")!, "http://localhost/");
  const note = await a.createNote(anchor, text);
  return note.id;
}

describe("chat plugin registration", () => {
  it("registers the Chat tab, the note action, and the chat.ask command", async () => {
    const { annotator: a } = attach(createEchoProvider());
    await seedNote(a);
    a.openSidebar();

    const tabs = [...shadow().querySelectorAll<HTMLElement>(".wm-tab[role=tab]")].map((t) => t.dataset.tabId);
    expect(tabs).toContain("chat");
    expect(a.commands.has("chat.ask")).toBe(true);

    const actions = [...shadow().querySelectorAll(".wm-note-actions button")].map((b) => b.textContent);
    expect(actions).toContain("Ask AI");
  });
});

describe("context assembly", () => {
  it("includes the resolved block text and surrounding text for a note", async () => {
    const { annotator: a, plugin } = attach(createEchoProvider());
    const id = await seedNote(a);

    const context = plugin.buildContext("note", id);
    expect(context.annotation?.id).toBe(id);
    expect(context.targetText).toContain("Authentication is handled");
    expect(context.surroundingText).toContain("Preceding paragraph");
    expect(context.surroundingText).toContain("Following paragraph");
    expect(context.pageText).toBeUndefined();
  });

  it("falls back to the stored quote when the note is detached", async () => {
    const { annotator: a, plugin } = attach(createEchoProvider());
    const id = await seedNote(a);
    document.body.innerHTML = `<p>Something else entirely about gardening.</p>`;
    await a.refresh();

    expect(a.getNotes()[0].resolution.status).toBe("detached");
    expect(plugin.buildContext("note", id).targetText).toContain("Authentication is handled");
  });

  it("sends all page notes for the all-notes scope, and page text for the page scope", async () => {
    const { annotator: a, plugin } = attach(createEchoProvider());
    await seedNote(a, "first");
    const all = plugin.buildContext("all-notes");
    expect(all.pageAnnotations).toHaveLength(1);
    expect(all.pageText).toBeUndefined();

    const page = plugin.buildContext("page");
    expect(page.pageAnnotations).toBeUndefined();
    expect(typeof page.pageText).toBe("string");
  });

  it("does not leak the annotator's own UI text into page context", async () => {
    const { annotator: a, plugin } = attach(createEchoProvider());
    await seedNote(a);
    a.openSidebar();
    // The sidebar lives in a shadow root, so body.innerText must not contain its chrome.
    expect(plugin.buildContext("page").pageText ?? "").not.toContain("notes on this page");
  });
});

describe("asking", () => {
  it("appends user and assistant turns for a promise provider", async () => {
    const provider: ChatProvider = {
      name: "fake",
      send: async () => ({ content: "the answer" }),
    };
    const { annotator: a, plugin } = attach(provider);
    await seedNote(a);

    const reply = await plugin.ask("page", "what is this page about?");
    expect(reply).toBe("the answer");
    expect(plugin.getTranscript()).toEqual([
      { role: "user", content: "what is this page about?" },
      { role: "assistant", content: "the answer" },
    ]);
  });

  it("concatenates streamed chunks in order", async () => {
    const provider: ChatProvider = {
      name: "fake-stream",
      send: async function* () {
        yield { delta: "Hello" };
        yield { delta: ", " };
        yield { delta: "world" };
      },
    };
    const { plugin } = attach(provider);
    expect(await plugin.ask("page", "hi")).toBe("Hello, world");
    expect(plugin.getTranscript()[1]).toEqual({ role: "assistant", content: "Hello, world" });
  });

  it("keeps the user message after a provider error and stays usable", async () => {
    let calls = 0;
    const provider: ChatProvider = {
      name: "flaky",
      send: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { content: "second time lucky" };
      },
    };
    const { plugin } = attach(provider);

    await expect(plugin.ask("page", "first try")).rejects.toThrow("boom");
    expect(plugin.getTranscript()).toEqual([{ role: "user", content: "first try" }]);

    expect(await plugin.ask("page", "retry")).toBe("second time lucky");
  });

  it("passes an abort signal that fires on destroy", async () => {
    let seen: AbortSignal | undefined;
    const provider: ChatProvider = {
      name: "hanging",
      send: (request) => {
        seen = request.signal;
        return new Promise(() => {}); // never settles
      },
    };
    const { annotator: a, plugin } = attach(provider);
    void plugin.ask("page", "question").catch(() => {});
    await Promise.resolve();

    expect(seen?.aborted).toBe(false);
    a.destroy();
    annotator = null;
    expect(seen?.aborted).toBe(true);
  });

  it("ignores empty questions", async () => {
    const send = vi.fn();
    const { plugin } = attach({ name: "fake", send: send as never });
    expect(await plugin.ask("page", "   ")).toBe("");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("settings privacy", () => {
  it("never includes stored settings (API keys) in an export", async () => {
    const storage = createMemoryStorage();
    await storage.setSetting("chat.apiKey", "sk-ant-secret-value");

    const a = createAnnotator({ storage });
    annotator = a;
    const portable = createPortableDataPlugin();
    a.use(portable);
    await seedNote(a);

    const exported = JSON.stringify(await portable.exportJSON());
    expect(exported).not.toContain("sk-ant-secret-value");
    expect(exported).not.toContain("apiKey");
  });
});
