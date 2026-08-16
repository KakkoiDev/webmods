// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotator, parseNoteFragment } from "../src/annotator";
import { createAnchor } from "../src/anchors";
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

  it("cleans up its UI and listeners on destroy", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    expect(document.querySelector("[data-wm-annotate-ui]")).toBeTruthy();
    annotator.destroy();
    expect(document.querySelector("[data-wm-annotate-ui]")).toBeNull();
    annotator = null;
  });
});
