/**
 * Reference Tampermonkey host for @webmods/annotate.
 * Deliberately thin: storage adapter + default UI + menu commands/shortcut.
 * All annotation logic lives in the library.
 */
import { createAnnotator } from "./annotator";
import { createChatPlugin } from "./plugins/chat";
import { createGlobalBrowserPlugin } from "./plugins/global-browser";
import { createExcalidrawPlugin } from "./plugins/excalidraw";
import { createGistPlugin } from "./plugins/gist";
import { createFirstmatePlugin } from "./plugins/firstmate";
import { createPortableDataPlugin } from "./plugins/portable-data";
import { createClaudeProvider } from "./providers/claude";
import { createOpenAIProvider } from "./providers/openai";
import type { ChatProvider } from "./plugins/chat";
import { createTampermonkeyStorage } from "./storage";

declare function GM_registerMenuCommand(caption: string, onClick: () => void): void;

interface GMResponse {
  status: number;
  responseText: string;
}

declare function GM_xmlhttpRequest(details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  onload(response: GMResponse): void;
  onerror(error: unknown): void;
}): void;

/**
 * fetch over GM_xmlhttpRequest. A page CSP (Notion, GitHub) blocks a direct
 * fetch to api.github.com, and the userscript sandbox is not bound by it.
 */
function gmFetch(input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: init.method ?? "GET",
      url: String(input),
      headers: (init.headers as Record<string, string>) ?? {},
      data: typeof init.body === "string" ? init.body : undefined,
      onload: (response) =>
        resolve({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => JSON.parse(response.responseText),
          text: async () => response.responseText,
        } as Response),
      onerror: (error) => reject(error instanceof Error ? error : new Error(String(error))),
    });
  });
}

declare function GM_download(details: {
  url: string | Blob;
  name: string;
  saveAs?: boolean;
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  onload?(): void;
  onerror?(error: { error?: string; details?: unknown }): void;
  ontimeout?(): void;
}): void;

declare const GM_info: { downloadMode?: string } | undefined;

/**
 * Save under the Downloads folder with GM_download. Subfolders in `name` are
 * only honored in Tampermonkey's "Browser API" download mode; the native mode
 * flattens "a/b.json" into "a_b.json", which the watcher would never find.
 */
function gmSave(path: string, text: string, { overwrite }: { overwrite: boolean }): Promise<void> {
  const mode = typeof GM_info === "object" ? GM_info?.downloadMode : undefined;
  if (typeof GM_download !== "function" || mode !== "browser") {
    return Promise.reject(
      new Error(
        `Tampermonkey download mode is "${mode ?? "unavailable"}". In the Tampermonkey dashboard's Settings tab, set ` +
          'Config mode to Advanced, then Download Mode to "Browser API", and allow the downloads permission.'
      )
    );
  }
  return new Promise((resolve, reject) => {
    GM_download({
      url: new Blob([text], { type: "application/json" }),
      name: path,
      saveAs: false,
      conflictAction: overwrite ? "overwrite" : "uniquify",
      onload: () => resolve(),
      onerror: (e) => reject(new Error(`download ${e?.error ?? "failed"}${e?.details ? `: ${JSON.stringify(e.details)}` : ""}`)),
      ontimeout: () => reject(new Error("download timed out")),
    });
  });
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

const CHAT_PROVIDER_SETTING = "chat.provider";
const CHAT_KEY_SETTING = "chat.apiKey";
const CHAT_MODEL_SETTING = "chat.model";
const CHAT_BASE_URL_SETTING = "chat.baseURL";

/** Build the configured provider. Anthropic and any OpenAI-compatible API are supported. */
function buildProvider(kind: string | undefined, apiKey: string, model?: string, baseURL?: string): ChatProvider {
  if (kind === "openai") return createOpenAIProvider({ apiKey, model, baseURL });
  return createClaudeProvider({ apiKey, model });
}

const DEBUG = true;

export function startUserscript(): void {
  if (DEBUG) {
    console.log("[wm-annotate] file executing", {
      version: "2026.08.18.9",
      url: location.href,
      grants: ["GM_getValue", "GM_setValue", "GM_registerMenuCommand", "GM_setClipboard", "GM_xmlhttpRequest"]
        .map((n) => `${n}=${typeof (globalThis as Record<string, unknown>)[n]}`)
        .join(" "),
    });
    window.addEventListener("error", (e) => console.log("[wm-annotate] window error", e.message));
  }
  const storage = createTampermonkeyStorage();
  const annotator = createAnnotator({ storage });

  const portable = createPortableDataPlugin();
  annotator.use(portable);
  // Lazy: Excalidraw only loads (from esm.sh) the first time a board is opened.
  annotator.use(createExcalidrawPlugin());
  // Tiny and lazy: all work happens when the All pages tab is opened.
  annotator.use(createGlobalBrowserPlugin());
  const gist = createGistPlugin({ fetchFn: typeof GM_xmlhttpRequest === "function" ? gmFetch : undefined });
  annotator.use(gist);
  annotator.use(createFirstmatePlugin({ save: gmSave }));

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
    GM_registerMenuCommand("Upload this site to a secret gist", () => void annotator.commands.execute("gist.upload", "site"));
    GM_registerMenuCommand("Upload all sites to a secret gist", () => void annotator.commands.execute("gist.upload", "all"));
    GM_registerMenuCommand("Send to firstmate", () => annotator.commands.execute("firstmate.send"));
    GM_registerMenuCommand("Set firstmate folder…", () => annotator.commands.execute("firstmate.configure-root"));
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
  if (DEBUG) {
    console.log("[wm-annotate] startUserscript finished", {
      uiHosts: document.querySelectorAll("[data-wm-annotate-ui]").length,
    });
  }
}
