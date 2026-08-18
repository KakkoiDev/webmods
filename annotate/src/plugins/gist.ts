import { copyText } from "../dom-utils";
import type { AnnotatorPlugin, HeaderActionItem, PluginContext } from "../types";
import { SCHEMA_VERSION } from "../types";
import { collectPages, filterPagesByScope } from "./portable-data";
import type { ExportDocument, ExportScope } from "./portable-data";

export const GIST_TOKEN_SETTING = "gist.token";
export const GIST_URL_SETTING = "gist.url";

/** One stable name, so every upload updates the same file instead of piling up copies. */
export const GIST_FILENAME = "webmods-annotations.json";

const API = "https://api.github.com";

export interface GistUploadOptions {
  /** Gist to update. Omitted: the stored one, or a new gist when nothing is stored. */
  url?: string;
  token?: string;
}

export interface GistUploadResult {
  id: string;
  url: string;
  /** False when an existing gist was updated. */
  created: boolean;
  notes: number;
  pages: number;
}

export interface GistPluginOptions {
  /** Injectable for tests, or to route through GM_xmlhttpRequest on CSP-strict sites. */
  fetchFn?: typeof fetch;
  /** Defaults to window.prompt. */
  prompt?(message: string, initial?: string): string | null;
  /** Defaults to window.alert. */
  notify?(message: string): void;
}

export interface GistPlugin extends AnnotatorPlugin {
  upload(scope: ExportScope, options?: GistUploadOptions): Promise<GistUploadResult>;
}

/**
 * Pull a gist id out of anything a user is likely to paste: a gist.github.com
 * URL with or without the owner, an API URL, or the bare id.
 */
export function parseGistId(input: string | null | undefined): string | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  if (/^[0-9a-f]{20,}$/i.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (host !== "gist.github.com" && host !== "api.github.com" && host !== "gist.github.com:443") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last && /^[0-9a-f]{20,}$/i.test(last) ? last : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function scopeLabel(scope: ExportScope, host: string | null): string {
  if (scope === "all") return "all sites";
  if (scope === "page") return "this page";
  return host ?? "this site";
}

interface GistResponse {
  id?: string;
  html_url?: string;
  message?: string;
}

export function createGistPlugin(options: GistPluginOptions = {}): GistPlugin {
  let ctx: PluginContext | null = null;
  const cleanups: Array<() => void> = [];

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("gist plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  const ask = options.prompt ?? ((message: string, initial?: string) => globalThis.prompt?.(message, initial) ?? null);
  const notify = options.notify ?? ((message: string) => globalThis.alert?.(message));

  const getSetting = async (key: string): Promise<string | null> => {
    const value = await requireCtx().storage.getSetting?.<string>(key);
    return typeof value === "string" && value ? value : null;
  };

  const setSetting = async (key: string, value: string | null): Promise<void> => {
    await requireCtx().storage.setSetting?.(key, value ?? undefined);
  };

  async function resolveToken(explicit?: string): Promise<string> {
    const stored = explicit ?? (await getSetting(GIST_TOKEN_SETTING));
    if (stored) return stored;
    const entered = ask(
      "GitHub token with the gist scope (stored in Tampermonkey storage only, never exported).\n\n" +
        "Create one at https://github.com/settings/tokens - a fine-grained token needs the Gists " +
        "read and write permission; a classic token needs the gist scope.",
      ""
    );
    const token = entered?.trim();
    if (!token) throw new Error("A GitHub token with the gist scope is required to upload.");
    await setSetting(GIST_TOKEN_SETTING, token);
    return token;
  }

  async function upload(scope: ExportScope, opts: GistUploadOptions = {}): Promise<GistUploadResult> {
    const c = requireCtx();
    const page = c.getPage();
    const token = await resolveToken(opts.token);
    const id = parseGistId(opts.url ?? (await getSetting(GIST_URL_SETTING)));

    const pages = filterPagesByScope(await collectPages(c.storage, page), page, scope);
    const notes = pages.reduce((sum, p) => sum + p.annotations.length, 0);
    const doc: ExportDocument = {
      format: "wm-annotate-export",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      pages,
    };

    const body = {
      description: `webmods annotate: ${scopeLabel(scope, hostOf(page.normalizedUrl))}, ${notes} note${
        notes === 1 ? "" : "s"
      } on ${pages.length} page${pages.length === 1 ? "" : "s"}`,
      // GitHub calls these secret gists: unlisted and not searchable, but
      // readable by anyone who has the URL.
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(doc, null, 2) } },
    };

    const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    const response = await doFetch(id ? `${API}/gists/${id}` : `${API}/gists`, {
      method: id ? "PATCH" : "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });

    let payload: GistResponse = {};
    try {
      payload = (await response.json()) as GistResponse;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const detail = payload.message ? `: ${payload.message}` : "";
      if (response.status === 401) throw new Error(`GitHub rejected the token (401)${detail}`);
      if (response.status === 404 && id) {
        throw new Error(`Gist ${id} not found, or the token cannot write to it (404)${detail}`);
      }
      throw new Error(`GitHub gist upload failed (${response.status})${detail}`);
    }
    const url = payload.html_url;
    const gistId = payload.id;
    if (!url || !gistId) throw new Error("GitHub returned no gist URL");

    await setSetting(GIST_URL_SETTING, url);
    return { id: gistId, url, created: !id, notes, pages: pages.length };
  }

  const run = (scope: ExportScope): void => {
    void upload(scope)
      .then(async (result) => {
        await copyText(result.url).catch(() => {});
        notify(
          `${result.created ? "Created" : "Updated"} secret gist with ${result.notes} note${
            result.notes === 1 ? "" : "s"
          } on ${result.pages} page${result.pages === 1 ? "" : "s"}.\n\n${result.url}\n\n(URL copied to the clipboard.)`
        );
      })
      .catch((err) => notify(`Gist upload failed: ${err instanceof Error ? err.message : err}`));
  };

  const plugin: GistPlugin = {
    name: "gist",

    setup(pluginCtx) {
      ctx = pluginCtx;
      cleanups.push(
        pluginCtx.commands.register("gist.upload", (scope) => upload((scope as ExportScope) ?? "all"))
      );

      cleanups.push(
        pluginCtx.addHeaderAction({
          id: "gist",
          label: "Gist",
          title: "Upload notes to a secret GitHub gist",
          items: () => {
            const host = hostOf(pluginCtx.getPage().normalizedUrl);
            const entries: HeaderActionItem[] = [
              { group: "Upload to a secret gist" },
              { label: `This site${host ? ` (${host})` : ""}`, onClick: () => run("site") },
              { label: "All sites", onClick: () => run("all") },
              { group: "Settings" },
              {
                label: "GitHub token…",
                onClick: () => {
                  void (async () => {
                    const entered = ask(
                      "GitHub token with the gist scope. Blank clears it.",
                      (await getSetting(GIST_TOKEN_SETTING)) ?? ""
                    );
                    if (entered === null) return;
                    await setSetting(GIST_TOKEN_SETTING, entered.trim() || null);
                  })();
                },
              },
              {
                label: "Target gist…",
                onClick: () => {
                  void (async () => {
                    const current = (await getSetting(GIST_URL_SETTING)) ?? "";
                    const entered = ask(
                      "Gist URL to update. Blank creates a new secret gist on the next upload.",
                      current
                    );
                    if (entered === null) return;
                    const trimmed = entered.trim();
                    if (trimmed && !parseGistId(trimmed)) {
                      notify("That does not look like a gist URL or id. Nothing saved.");
                      return;
                    }
                    await setSetting(GIST_URL_SETTING, trimmed || null);
                  })();
                },
              },
            ];
            return entries;
          },
        })
      );
    },

    destroy() {
      for (const off of cleanups.splice(0)) off();
      ctx = null;
    },

    upload,
  };

  return plugin;
}
