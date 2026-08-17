// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotator, parseNoteFragment } from "../src/annotator";
import { createAnchor } from "../src/anchors";
import { createRangeAnchor } from "../src/ranges";
import { createMemoryStorage } from "../src/storage";
import type { Annotator } from "../src/types";

let annotator: Annotator | null = null;

afterEach(() => {
  annotator?.destroy();
  annotator = null;
  document.body.innerHTML = "";
});

describe("parseNoteFragment", () => {
  it("extracts the note id", () => {
    expect(parseNoteFragment("#wm-note=abc123")).toBe("abc123");
    expect(parseNoteFragment("#section&wm-note=abc")).toBe("abc");
    expect(parseNoteFragment("#section")).toBeNull();
    expect(parseNoteFragment("")).toBeNull();
  });
});

describe("createAnnotator", () => {
  it("switches modes and emits events", () => {
    const modes: string[] = [];
    annotator = createAnnotator({ storage: createMemoryStorage(), onModeChange: (m) => modes.push(m) });
    expect(annotator.getMode()).toBe("explore");
    annotator.enter();
    expect(annotator.getMode()).toBe("annotate");
    annotator.toggle();
    expect(annotator.getMode()).toBe("explore");
    expect(modes).toEqual(["annotate", "explore"]);
  });

  it("creates, updates, and deletes notes through storage", async () => {
    document.body.innerHTML = `<p id="target">Some annotatable paragraph text.</p>`;
    const storage = createMemoryStorage();
    annotator = createAnnotator({ storage });

    const anchor = createAnchor(document.getElementById("target")!, "http://localhost/");
    const note = await annotator.createNote(anchor, "first draft");
    expect(note.body.text).toBe("first draft");
    expect((await annotator.getPageNotes()).length).toBe(1);

    const updated = await annotator.updateNote(note.id, { body: { type: "markdown", text: "edited" } });
    expect(updated.body.text).toBe("edited");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);

    await annotator.deleteNote(note.id);
    expect(await annotator.getNote(note.id)).toBeNull();
  });

  it("resolves stored notes on refresh and exposes them via getNotes", async () => {
    document.body.innerHTML = `<p id="target">A very identifiable paragraph of content.</p>`;
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const anchor = createAnchor(document.getElementById("target")!, "http://localhost/");
    await annotator.createNote(anchor, "note");

    const notes = annotator.getNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].resolution.status).toBe("resolved");
  });

  it("generates note URLs in the wm-note fragment namespace", async () => {
    document.body.innerHTML = `<p id="target">Anchor paragraph text goes here.</p>`;
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const anchor = createAnchor(document.getElementById("target")!, "http://localhost/");
    const note = await annotator.createNote(anchor, "note");
    const base = `${window.location.origin}${window.location.pathname}`;
    expect(annotator.getNoteURL(note.id)).toBe(`${base}#wm-note=${note.id}`);
  });

  it("registers core commands and runs plugins", async () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    expect(annotator.commands.has("annotate.toggle")).toBe(true);
    expect(annotator.commands.has("sidebar.toggle")).toBe(true);

    let setupCalled = false;
    annotator.use({ name: "test", setup: (ctx) => {
      setupCalled = true;
      expect(ctx.getPage().id).toMatch(/^pg_/);
    }});
    expect(setupCalled).toBe(true);

    annotator.commands.execute("annotate.enter");
    expect(annotator.getMode()).toBe("annotate");
  });

  it("stores and restores range notes through storage", async () => {
    document.body.innerHTML = `<p id="t">Tokens are validated at the edge before requests reach the servers.</p>`;
    const storage = createMemoryStorage();
    annotator = createAnnotator({ storage });

    const block = document.getElementById("t")!;
    const textNode = block.firstChild as Text;
    const at = block.textContent!.indexOf("validated at the edge");
    const range = document.createRange();
    range.setStart(textNode, at);
    range.setEnd(textNode, at + "validated at the edge".length);

    const anchor = createRangeAnchor(range, block, createAnchor(block, "http://localhost/"));
    const note = await annotator.createNote(anchor, "range note");

    const stored = await annotator.getNote(note.id);
    expect(stored!.anchor.kind).toBe("range");
    expect(stored!.anchor.textQuote?.exact).toBe("validated at the edge");

    await annotator.refresh();
    const resolution = annotator.getNotes()[0].resolution;
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.range?.toString()).toBe("validated at the edge");
    }
  });

  it("re-anchors a detached note onto a new element", async () => {
    document.body.innerHTML = `<p id="target">Original paragraph that will disappear entirely.</p>`;
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const anchor = createAnchor(document.getElementById("target")!, "http://localhost/");
    const note = await annotator.createNote(anchor, "keep me");
    expect(annotator.getNotes()[0].resolution.status).toBe("resolved");

    // The annotated content is gone; a different paragraph remains.
    document.body.innerHTML = `<p id="other">A completely different paragraph about gardening.</p>`;
    await annotator.refresh();
    expect(annotator.getNotes()[0].resolution.status).toBe("detached");

    const target = document.getElementById("other")!;
    const updated = await annotator.reanchorNote(note.id, target);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
    expect(updated.body.text).toBe("keep me");

    const resolution = annotator.getNotes()[0].resolution;
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") expect(resolution.element).toBe(target);
  });

  it("re-anchoring rejects unknown ids", async () => {
    document.body.innerHTML = `<p id="t">Some text.</p>`;
    annotator = createAnnotator({ storage: createMemoryStorage() });
    await expect(annotator.reanchorNote("nope", document.getElementById("t")!)).rejects.toThrow("not found");
  });

  it("registers the note.reattach command", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    expect(annotator.commands.has("note.reattach")).toBe(true);
  });

  it("cleans up its UI and listeners on destroy", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    expect(document.querySelector("[data-wm-annotate-ui]")).toBeTruthy();
    annotator.destroy();
    expect(document.querySelector("[data-wm-annotate-ui]")).toBeNull();
    annotator = null;
  });
});

describe("shortcuts inside editors", () => {
  // jsdom leaves isContentEditable undefined; the browser derives it from the
  // nearest editable ancestor.
  function fakeContentEditable(): void {
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
      configurable: true,
      get(this: HTMLElement) {
        return !!this.closest('[contenteditable=""],[contenteditable="true"]');
      },
    });
  }

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).isContentEditable;
  });

  function pressToggle(target: Element): void {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "A", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  }

  it("toggles annotate mode from inside a page-wide editor", () => {
    document.body.innerHTML = `
      <div contenteditable="true">
        <div id="block">Add the Order and OrderLine models with their migration.</div>
        <div>${"Body text that makes this editable root document-sized. ".repeat(12)}</div>
      </div>
    `;
    fakeContentEditable();
    annotator = createAnnotator({ storage: createMemoryStorage() });
    pressToggle(document.getElementById("block")!);
    expect(annotator.getMode()).toBe("annotate");
  });

  it("stays out of the way while typing in an editable field", () => {
    document.body.innerHTML = `<div id="composer" contenteditable="true">Reply to this thread</div>`;
    fakeContentEditable();
    annotator = createAnnotator({ storage: createMemoryStorage() });
    pressToggle(document.getElementById("composer")!);
    expect(annotator.getMode()).toBe("explore");
  });

  // jsdom has no scrolling, so record how focus was requested: restoring focus to
  // the editor root without preventScroll jumps Notion back to the top of the page.
  it("restores focus after the composer closes without scrolling the page", async () => {
    document.body.innerHTML = `
      <div id="editor" contenteditable="true">
        <div id="block">Add the Order and OrderLine models with their migration.</div>
        <div>${"Body text that makes this editable root document-sized. ".repeat(12)}</div>
      </div>
    `;
    fakeContentEditable();
    Element.prototype.getBoundingClientRect = function () {
      const height = Math.max(20, Math.min(600, (this.textContent || "").length / 2));
      return { top: 100, left: 0, right: 600, bottom: 100 + height, width: 600, height, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
    };
    const calls: { el: Element; options?: FocusOptions }[] = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      calls.push({ el: this, options });
      return original.call(this, options);
    };
    try {
      const editor = document.getElementById("editor")!;
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => editor });
      annotator = createAnnotator({ storage: createMemoryStorage() });
      annotator.enter();
      document.getElementById("block")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const textarea = document.querySelector("[data-wm-annotate-ui]")!.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
      textarea.value = "a note";
      const save = [...document.querySelector("[data-wm-annotate-ui]")!.shadowRoot!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
      save.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      const restore = calls.filter((c) => c.el === editor);
      expect(restore.length).toBe(1);
      expect(restore[0].options?.preventScroll).toBe(true);
    } finally {
      HTMLElement.prototype.focus = original;
      delete (document as Partial<Document>).activeElement;
    }
  });
});
