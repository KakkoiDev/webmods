/**
 * Reference Tampermonkey host for @webmods/annotate.
 * Deliberately thin: storage adapter + default UI + menu commands/shortcut.
 * All annotation logic lives in the library.
 */
import { createAnnotator } from "./annotator";
import { createChatPlugin } from "./plugins/chat";
import { createGlobalBrowserPlugin } from "./plugins/global-browser";
import { createExcalidrawPlugin } from "./plugins/excalidraw";
import { createPortableDataPlugin } from "./plugins/portable-data";
import { createClaudeProvider } from "./providers/claude";
import { createOpenAIProvider } from "./providers/openai";
import type { ChatProvider } from "./plugins/chat";
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

const CHAT_PROVIDER_SETTING = "chat.provider";
const CHAT_KEY_SETTING = "chat.apiKey";
const CHAT_MODEL_SETTING = "chat.model";
const CHAT_BASE_URL_SETTING = "chat.baseURL";

/** Build the configured provider. Anthropic and any OpenAI-compatible API are supported. */
function buildProvider(kind: string | undefined, apiKey: string, model?: string, baseURL?: string): ChatProvider {
  if (kind === "openai") return createOpenAIProvider({ apiKey, model, baseURL });
  return createClaudeProvider({ apiKey, model });
}

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
    const [kind, model, baseURL] = await Promise.all([
      storage.getSetting<string>(CHAT_PROVIDER_SETTING),
      storage.getSetting<string>(CHAT_MODEL_SETTING),
      storage.getSetting<string>(CHAT_BASE_URL_SETTING),
    ]);
    annotator.use(createChatPlugin({ provider: buildProvider(kind, apiKey, model, baseURL) }));
  })();

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Toggle annotate mode (Alt+Shift+A)", () => annotator.toggle());
    GM_registerMenuCommand("Toggle notes sidebar", () => annotator.toggleSidebar());
    GM_registerMenuCommand("Browse all annotations", () => annotator.commands.execute("browser.open"));
    GM_registerMenuCommand("Export this site (JSON)", () => portable.downloadExport("json", { scope: "site" }));
    GM_registerMenuCommand("Export this site (Markdown)", () => portable.downloadExport("markdown", { scope: "site" }));
    GM_registerMenuCommand("Export all sites (JSON)", () => portable.downloadExport("json", { scope: "all" }));
    GM_registerMenuCommand("Export all sites (Markdown)", () => portable.downloadExport("markdown", { scope: "all" }));
    GM_registerMenuCommand("Configure AI chat…", async () => {
      const currentKind = (await storage.getSetting<string>(CHAT_PROVIDER_SETTING)) ?? "anthropic";
      const kindInput = prompt(
        'Provider: "anthropic" or "openai".\n\n"openai" also works with any OpenAI-compatible API ' +
          "(OpenRouter, Groq, Together, local Ollama) — you'll be asked for a base URL.",
        currentKind
      );
      if (kindInput === null) return;
      const kind = kindInput.trim().toLowerCase() === "openai" ? "openai" : "anthropic";
      await storage.setSetting?.(CHAT_PROVIDER_SETTING, kind);

      const current = await storage.getSetting<string>(CHAT_KEY_SETTING);
      const key = prompt(
        `${kind === "openai" ? "OpenAI" : "Anthropic"} API key (stored in Tampermonkey storage only, ` +
          "never exported). Leave blank to disable AI chat.",
        current ?? ""
      );
      if (key === null) return;
      await storage.setSetting?.(CHAT_KEY_SETTING, key.trim());

      if (key.trim()) {
        const defaultModel = kind === "openai" ? "gpt-5" : "claude-opus-5";
        const model = prompt(`Model (blank for the default, ${defaultModel}):`, "");
        if (model !== null) await storage.setSetting?.(CHAT_MODEL_SETTING, model.trim() || undefined);

        if (kind === "openai") {
          const baseURL = prompt(
            "Base URL (blank for OpenAI). Examples:\n" +
              "  https://openrouter.ai/api/v1\n" +
              "  http://localhost:11434/v1",
            (await storage.getSetting<string>(CHAT_BASE_URL_SETTING)) ?? ""
          );
          if (baseURL !== null) await storage.setSetting?.(CHAT_BASE_URL_SETTING, baseURL.trim() || undefined);
        }
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
