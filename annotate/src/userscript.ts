/**
 * Reference Tampermonkey host for @webmods/annotate.
 * Deliberately thin: storage adapter + default UI + menu commands/shortcut.
 * All annotation logic lives in the library.
 */
import { createAnnotator } from "./annotator";
import { download } from "./dom-utils";
import { createChatPlugin } from "./plugins/chat";
import { createGlobalBrowserPlugin } from "./plugins/global-browser";
import { createExcalidrawPlugin } from "./plugins/excalidraw";
import { createPortableDataPlugin } from "./plugins/portable-data";
import { createClaudeProvider } from "./providers/claude";
import { createTampermonkeyStorage } from "./storage";

declare function GM_registerMenuCommand(caption: string, onClick: () => void): void;

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

const CHAT_KEY_SETTING = "chat.apiKey";
const CHAT_MODEL_SETTING = "chat.model";

export function startUserscript(): void {
  const storage = createTampermonkeyStorage();
  const annotator = createAnnotator({ storage });

  const portable = createPortableDataPlugin();
  annotator.use(portable);
  // Lazy: Excalidraw only loads (from esm.sh) the first time a board is opened.
  annotator.use(createExcalidrawPlugin());
  // Tiny and lazy: all work happens when the All pages tab is opened.
  annotator.use(createGlobalBrowserPlugin());

  // The Chat tab only exists once an API key is configured; nothing is ever
  // sent anywhere until the user presses Send.
  void (async () => {
    const apiKey = await storage.getSetting<string>(CHAT_KEY_SETTING);
    if (!apiKey) return;
    const model = await storage.getSetting<string>(CHAT_MODEL_SETTING);
    annotator.use(createChatPlugin({ provider: createClaudeProvider({ apiKey, model }) }));
  })();

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Toggle annotate mode (Alt+Shift+A)", () => annotator.toggle());
    GM_registerMenuCommand("Toggle notes sidebar", () => annotator.toggleSidebar());
    GM_registerMenuCommand("Browse all annotations", () => annotator.commands.execute("browser.open"));
    GM_registerMenuCommand("Export annotations (JSON)", async () => {
      const doc = await portable.exportJSON();
      download(`webmods-annotations-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc, null, 2), "application/json");
    });
    GM_registerMenuCommand("Export annotations (Markdown)", async () => {
      const md = await portable.exportMarkdown();
      download(`webmods-annotations-${new Date().toISOString().slice(0, 10)}.md`, md, "text/markdown");
    });
    GM_registerMenuCommand("Configure AI chat…", async () => {
      const current = await storage.getSetting<string>(CHAT_KEY_SETTING);
      const key = prompt(
        "Anthropic API key (stored in Tampermonkey storage only, never exported). Leave blank to disable AI chat.",
        current ?? ""
      );
      if (key === null) return;
      await storage.setSetting?.(CHAT_KEY_SETTING, key.trim());
      if (key.trim()) {
        const model = prompt("Model (blank for the default, claude-opus-5):", "");
        if (model !== null) await storage.setSetting?.(CHAT_MODEL_SETTING, model.trim() || undefined);
      }
      alert("Saved. Reload the page to apply.");
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
