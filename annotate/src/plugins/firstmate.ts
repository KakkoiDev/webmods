import { isArchived } from "../archive";
import type { Annotation, AnnotatorPlugin, HeaderActionItem, PageIdentity, PluginContext } from "../types";
import { DEFAULT_ROOT, folderFor, parseRoot } from "../url-folder";

/** Setting holding `{ [noteId]: updatedAt }` for every note version already sent. */
export const FIRSTMATE_SENT_SETTING = "firstmate.sent";
/** Setting holding the root folder, relative to the browser's Downloads folder. */
export const FIRSTMATE_ROOT_SETTING = "firstmate.root";
/** Written at the top of the Downloads folder on every send; the watcher reads the root from it. */
export const FIRSTMATE_CONFIG_FILENAME = "firstmate-annotate.config.json";

export const FIRSTMATE_FORMAT = "wm-annotate-firstmate";
export const FIRSTMATE_SCHEMA_VERSION = 1;

export interface FirstmateNote {
  id: string;
  anchor: {
    kind: "block" | "range";
    selector: string | null;
    quote: string | null;
    prefix: string | null;
    suffix: string | null;
  };
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface FirstmatePayload {
  format: typeof FIRSTMATE_FORMAT;
  schemaVersion: typeof FIRSTMATE_SCHEMA_VERSION;
  sentAt: string;
  /** Folder this file was saved to, relative to the Downloads folder. */
  folder: string;
  page: {
    url: string;
    title: string | null;
    localPath: string | null;
  };
  notes: FirstmateNote[];
}

export type SentMap = Record<string, number>;

/** Filesystem path of a file:// URL, or null for any other scheme. */
export function localPathOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  return decodeURIComponent(parsed.pathname);
}

/** A note is unsent when it was never sent, or edited after its last send. */
export function unsentNotes(notes: Annotation[], sent: SentMap): Annotation[] {
  return notes.filter((n) => !isArchived(n) && !(sent[n.id] >= n.updatedAt));
}

export function markSent(sent: SentMap, notes: Annotation[]): SentMap {
  const next = { ...sent };
  for (const n of notes) next[n.id] = n.updatedAt;
  return next;
}

export function buildFirstmatePayload(
  page: PageIdentity,
  notes: Annotation[],
  now: number,
  folder: string
): FirstmatePayload {
  return {
    format: FIRSTMATE_FORMAT,
    schemaVersion: FIRSTMATE_SCHEMA_VERSION,
    sentAt: new Date(now).toISOString(),
    folder,
    page: {
      url: page.url,
      title: page.title ?? null,
      localPath: localPathOf(page.url),
    },
    notes: notes
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => ({
        id: n.id,
        anchor: {
          kind: n.anchor.kind ?? "block",
          selector: n.anchor.selector ?? null,
          quote: n.anchor.textQuote?.exact ?? null,
          prefix: n.anchor.textQuote?.prefix ?? null,
          suffix: n.anchor.textQuote?.suffix ?? null,
        },
        body: n.body.text,
        createdAt: new Date(n.createdAt).toISOString(),
        updatedAt: new Date(n.updatedAt).toISOString(),
      })),
  };
}

/** `firstmate-annotate-20260928T032053.123Z.json`: ISO 8601 basic format, no colons for the filesystem. */
export function firstmateFilename(now: number): string {
  return `firstmate-annotate-${new Date(now).toISOString().replace(/[-:]/g, "")}.json`;
}

export interface FirstmateSendResult {
  sent: number;
  /** Saved path relative to the Downloads folder, or null when nothing was sent. */
  path: string | null;
}

export interface FirstmatePluginOptions {
  /**
   * Write `text` to `path`, relative to the browser's Downloads folder and
   * possibly with subfolders. `overwrite` replaces an existing file instead of
   * keeping both. Resolve only once the file is written; a rejection leaves the
   * notes unsent.
   */
  save(path: string, text: string, options: { overwrite: boolean }): void | Promise<void>;
  /** Defaults to window.alert. */
  notify?(message: string): void;
  /** Defaults to window.prompt. */
  prompt?(message: string, initial?: string): string | null;
  now?(): number;
}

export interface FirstmatePlugin extends AnnotatorPlugin {
  send(): Promise<FirstmateSendResult>;
}

export function createFirstmatePlugin(options: FirstmatePluginOptions): FirstmatePlugin {
  let ctx: PluginContext | null = null;
  const cleanups: Array<() => void> = [];

  const ask = options.prompt ?? ((message: string, initial?: string) => globalThis.prompt?.(message, initial) ?? null);
  const notify = options.notify ?? ((message: string) => globalThis.alert?.(message));
  const now = options.now ?? Date.now;

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("firstmate plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  async function getRoot(): Promise<string[]> {
    const stored = await requireCtx().storage.getSetting?.<string>(FIRSTMATE_ROOT_SETTING);
    return parseRoot(typeof stored === "string" ? stored : null);
  }

  async function send(): Promise<FirstmateSendResult> {
    const c = requireCtx();
    const page = c.getPage();
    const sent = ((await c.storage.getSetting?.<SentMap>(FIRSTMATE_SENT_SETTING)) ?? {}) as SentMap;
    const pending = unsentNotes(await c.storage.getPage(page), sent);
    if (!pending.length) return { sent: 0, path: null };

    const root = await getRoot();
    const folder = folderFor(page.url, root, localPathOf(page.url));
    const at = now();
    const path = `${folder}/${firstmateFilename(at)}`;
    await options.save(
      FIRSTMATE_CONFIG_FILENAME,
      JSON.stringify({ format: "wm-annotate-firstmate-config", root: root.join("/") }, null, 2) + "\n",
      { overwrite: true }
    );
    await options.save(path, JSON.stringify(buildFirstmatePayload(page, pending, at, folder), null, 2), {
      overwrite: false,
    });
    await c.storage.setSetting?.(FIRSTMATE_SENT_SETTING, markSent(sent, pending));
    return { sent: pending.length, path };
  }

  async function configureRoot(): Promise<void> {
    const c = requireCtx();
    const current = (await getRoot()).join("/");
    const entered = ask(
      "Folder for firstmate sends, relative to the browser's Downloads folder " +
        `(a-z, 0-9, ".", "_", "-", "/" between folders). Blank resets to ${DEFAULT_ROOT}.`,
      current
    );
    if (entered === null) return;
    try {
      const root = parseRoot(entered);
      await c.storage.setSetting?.(FIRSTMATE_ROOT_SETTING, root.join("/"));
      notify(`Firstmate folder set to Downloads/${root.join("/")}. The watcher picks it up on the next send.`);
    } catch (err) {
      notify(`Folder not saved: ${err instanceof Error ? err.message : err}`);
    }
  }

  const run = (): void => {
    void send()
      .then((result) =>
        notify(
          result.path
            ? `Sent ${result.sent} note${result.sent === 1 ? "" : "s"} to firstmate: Downloads/${result.path}`
            : "No new or edited notes on this page to send to firstmate."
        )
      )
      .catch((err) => notify(`Send to firstmate failed: ${err instanceof Error ? err.message : err}`));
  };

  const plugin: FirstmatePlugin = {
    name: "firstmate",

    setup(pluginCtx) {
      ctx = pluginCtx;
      cleanups.push(pluginCtx.commands.register("firstmate.send", () => run()));
      cleanups.push(pluginCtx.commands.register("firstmate.configure-root", () => configureRoot()));
      cleanups.push(
        pluginCtx.addHeaderAction({
          id: "firstmate",
          label: "Firstmate",
          title: "Send this page's unsent notes to firstmate",
          items: () => {
            const entries: HeaderActionItem[] = [
              { label: "Send to firstmate", onClick: run },
              { group: "Settings" },
              { label: "Folder…", onClick: () => void configureRoot() },
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

    send,
  };

  return plugin;
}
