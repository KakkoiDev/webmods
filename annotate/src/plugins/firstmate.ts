import { isArchived } from "../archive";
import { download } from "../dom-utils";
import type { Annotation, AnnotatorPlugin, PageIdentity, PluginContext } from "../types";

/** Setting holding `{ [noteId]: updatedAt }` for every note version already sent. */
export const FIRSTMATE_SENT_SETTING = "firstmate.sent";

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

export function buildFirstmatePayload(page: PageIdentity, notes: Annotation[], now: number): FirstmatePayload {
  return {
    format: FIRSTMATE_FORMAT,
    schemaVersion: FIRSTMATE_SCHEMA_VERSION,
    sentAt: new Date(now).toISOString(),
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
  filename: string | null;
}

export interface FirstmatePluginOptions {
  /** Defaults to a browser download. A rejection leaves the notes unsent. */
  save?(filename: string, text: string): void | Promise<void>;
  /** Defaults to window.alert. */
  notify?(message: string): void;
  now?(): number;
}

export interface FirstmatePlugin extends AnnotatorPlugin {
  send(): Promise<FirstmateSendResult>;
}

export function createFirstmatePlugin(options: FirstmatePluginOptions = {}): FirstmatePlugin {
  let ctx: PluginContext | null = null;
  const cleanups: Array<() => void> = [];

  const save = options.save ?? ((filename: string, text: string) => download(filename, text, "application/json"));
  const notify = options.notify ?? ((message: string) => globalThis.alert?.(message));
  const now = options.now ?? Date.now;

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("firstmate plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  async function send(): Promise<FirstmateSendResult> {
    const c = requireCtx();
    const page = c.getPage();
    const sent = ((await c.storage.getSetting?.<SentMap>(FIRSTMATE_SENT_SETTING)) ?? {}) as SentMap;
    const pending = unsentNotes(await c.storage.getPage(page), sent);
    if (!pending.length) return { sent: 0, filename: null };

    const at = now();
    const filename = firstmateFilename(at);
    await save(filename, JSON.stringify(buildFirstmatePayload(page, pending, at), null, 2));
    await c.storage.setSetting?.(FIRSTMATE_SENT_SETTING, markSent(sent, pending));
    return { sent: pending.length, filename };
  }

  const run = (): void => {
    void send()
      .then((result) =>
        notify(
          result.filename
            ? `Sent ${result.sent} note${result.sent === 1 ? "" : "s"} to firstmate as ${result.filename} ` +
                "(browser download folder)."
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
      cleanups.push(
        pluginCtx.addHeaderAction({
          id: "firstmate",
          label: "Send to firstmate",
          title: "Save this page's unsent notes as a JSON file for firstmate",
          onClick: run,
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
