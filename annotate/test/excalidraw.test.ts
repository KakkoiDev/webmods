import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnnotator } from "../src/annotator";
import { createAnchor } from "../src/anchors";
import { createExcalidrawPlugin, isExcalidrawAttachment, type ExcalidrawRuntime } from "../src/plugins/excalidraw";
import { createMemoryStorage } from "../src/storage";
import type { Annotator } from "../src/types";

let annotator: Annotator | null = null;

afterEach(() => {
  annotator?.destroy();
  annotator = null;
  document.body.innerHTML = "";
});

/** Fake runtime: renders nothing but hands the plugin a working scene API. */
function fakeRuntime(elements: unknown[] = []): { runtime: ExcalidrawRuntime } {
  let props: any = null;
  const runtime: ExcalidrawRuntime = {
    React: { createElement: (_type, p) => ((props = p), null) },
    createRoot: () => ({
      render: () => {
        // Simulate Excalidraw mounting and handing back its imperative API.
        props?.excalidrawAPI?.({
          getSceneElements: () => elements,
          getAppState: () => ({ viewBackgroundColor: "#ffffff" }),
          getFiles: () => ({}),
        });
      },
      unmount: () => {},
    }),
    excalidraw: {
      Excalidraw: () => null,
      exportToSvg: async () => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 10 10");
        return svg as SVGSVGElement;
      },
    },
  };
  return { runtime };
}

async function makeNote(a: Annotator): Promise<string> {
  document.body.innerHTML = `<p id="t">A paragraph worth annotating for the whiteboard test.</p>`;
  const anchor = createAnchor(document.getElementById("t")!, "http://localhost/");
  const note = await a.createNote(anchor, "note with a drawing");
  return note.id;
}

describe("excalidraw plugin", () => {
  it("is lazy: the loader never runs until a board is opened", async () => {
    const loader = vi.fn(async () => fakeRuntime().runtime);
    annotator = createAnnotator({ storage: createMemoryStorage() });
    annotator.use(createExcalidrawPlugin({ loader }));
    await makeNote(annotator);
    expect(loader).not.toHaveBeenCalled();
  });

  it("registers the note.open-board command and a note action", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    annotator.use(createExcalidrawPlugin({ loader: async () => fakeRuntime().runtime }));
    expect(annotator.commands.has("note.open-board")).toBe(true);
  });

  it("opens a board, saves the scene as an attachment with a preview, and closes", async () => {
    const { runtime } = fakeRuntime([{ type: "rectangle", id: "r1" }]);
    const loader = vi.fn(async () => runtime);
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const plugin = createExcalidrawPlugin({ loader });
    annotator.use(plugin);
    const id = await makeNote(annotator);

    await plugin.open(id);
    expect(plugin.isOpen()).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);

    // Click the modal's Save button.
    const modal = [...document.querySelectorAll("[data-wm-annotate-ui]")].find((el) => el.getAttribute("role") === "dialog")!;
    const saveBtn = [...modal.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(plugin.isOpen()).toBe(false);
    const saved = await annotator.getNote(id);
    const att = saved!.attachments!.find(isExcalidrawAttachment)!;
    expect(att.scene.elements).toEqual([{ type: "rectangle", id: "r1" }]);
    expect(att.preview).toContain("<svg");
  });

  it("reopening edits the same attachment instead of adding a second one", async () => {
    const { runtime } = fakeRuntime([{ type: "ellipse", id: "e1" }]);
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const plugin = createExcalidrawPlugin({ loader: async () => runtime });
    annotator.use(plugin);
    const id = await makeNote(annotator);

    for (let i = 0; i < 2; i++) {
      await plugin.open(id);
      const modal = [...document.querySelectorAll("[data-wm-annotate-ui]")].find((el) => el.getAttribute("role") === "dialog")!;
      [...modal.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click();
      await new Promise((r) => setTimeout(r, 50));
    }

    const saved = await annotator.getNote(id);
    expect(saved!.attachments!.filter(isExcalidrawAttachment)).toHaveLength(1);
  });

  it("scene survives a JSON export/import round-trip", async () => {
    const { runtime } = fakeRuntime([{ type: "arrow", id: "a1" }]);
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const plugin = createExcalidrawPlugin({ loader: async () => runtime });
    annotator.use(plugin);
    const id = await makeNote(annotator);
    await plugin.open(id);
    const modal = [...document.querySelectorAll("[data-wm-annotate-ui]")].find((el) => el.getAttribute("role") === "dialog")!;
    [...modal.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click();
    await new Promise((r) => setTimeout(r, 50));

    const exported = JSON.parse(JSON.stringify({
      format: "wm-annotate-export",
      schemaVersion: 1,
      exportedAt: 0,
      pages: [{ identity: annotator.getPage(), annotations: [await annotator.getNote(id)] }],
    }));
    const att = exported.pages[0].annotations[0].attachments.find((a: any) => a.type === "excalidraw");
    expect(att.scene.elements).toEqual([{ type: "arrow", id: "a1" }]);
  });

  it("cleans up its modal on destroy", async () => {
    const { runtime } = fakeRuntime();
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const plugin = createExcalidrawPlugin({ loader: async () => runtime });
    annotator.use(plugin);
    const id = await makeNote(annotator);
    await plugin.open(id);
    expect(plugin.isOpen()).toBe(true);
    annotator.destroy();
    annotator = null;
    expect(document.querySelectorAll("[role=dialog][data-wm-annotate-ui]")).toHaveLength(0);
  });
});
