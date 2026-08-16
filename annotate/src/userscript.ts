/**
 * Reference Tampermonkey host for @webmods/annotate.
 * Deliberately thin: storage adapter + default UI + menu commands/shortcut.
 * All annotation logic lives in the library.
 */
import { createAnnotator } from "./annotator";
import { createExcalidrawPlugin } from "./plugins/excalidraw";
import { createPortableDataPlugin } from "./plugins/portable-data";
import { createTampermonkeyStorage } from "./storage";

declare function GM_registerMenuCommand(caption: string, onClick: () => void): void;

function download(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    input.click();
  });
}

export function startUserscript(): void {
  const annotator = createAnnotator({
    storage: createTampermonkeyStorage(),
  });

  const portable = createPortableDataPlugin();
  annotator.use(portable);
  // Lazy: Excalidraw only loads (from esm.sh) the first time a board is opened.
  annotator.use(createExcalidrawPlugin());

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Toggle annotate mode (Alt+Shift+A)", () => annotator.toggle());
    GM_registerMenuCommand("Toggle notes sidebar", () => annotator.toggleSidebar());
    GM_registerMenuCommand("Export annotations (JSON)", async () => {
      const doc = await portable.exportJSON();
      download(`webmods-annotations-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc, null, 2), "application/json");
    });
    GM_registerMenuCommand("Export annotations (Markdown)", async () => {
      const md = await portable.exportMarkdown();
      download(`webmods-annotations-${new Date().toISOString().slice(0, 10)}.md`, md, "text/markdown");
    });
    GM_registerMenuCommand("Import annotations (JSON)", async () => {
      const text = await pickFile("application/json,.json");
      if (!text) return;
      try {
        const result = await portable.importJSON(text, "skip");
        alert(`Imported ${result.imported} annotation(s), skipped ${result.skipped} existing.`);
      } catch (err) {
        alert(`Import failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  (globalThis as Record<string, any>).__wmAnnotate = annotator;
}
