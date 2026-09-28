import { isArchived } from "../archive";
import { renderMarkdown } from "../markdown";
import type { Annotation, AnnotatorPlugin, HeaderActionItem, PageIdentity, PluginContext } from "../types";
import { DEFAULT_ROOT, colocatedFolder, docPathOf, folderFor, parseRoot, servedDocRel } from "../url-folder";
import {
  NO_RECEIPT_MS,
  noteProgress,
  realTimers,
  repliesFor,
  replyHref,
  sendProgress,
  startFeed,
  statusForSend,
  type FeedLoop,
  type FeedRequest,
  type FirstmateFeed,
  type LocalSend,
  type Progress,
  type ProgressView,
  type Timers,
} from "./firstmate-feed";

/** Setting holding `{ [noteId]: updatedAt }` for every note version already sent. */
export const FIRSTMATE_SENT_SETTING = "firstmate.sent";
/** Setting holding the root folder, relative to the browser's Downloads folder. */
export const FIRSTMATE_ROOT_SETTING = "firstmate.root";
/** Setting holding the live-reload port the watcher serves on 127.0.0.1. */
export const FIRSTMATE_PORT_SETTING = "firstmate.reloadPort";
/** Setting holding `{ [folder]: LocalSend }`: the last send from each per-URL folder. */
export const FIRSTMATE_SENDS_SETTING = "firstmate.sends";
/** Annotation metadata key holding the captain's thread replies, `[{ at, text }]`. */
export const FIRSTMATE_REPLIES_KEY = "firstmateReplies";
export const DEFAULT_RELOAD_PORT = 4817;
/** Written at the top of the Downloads folder on every send; the watcher reads root and port from it. */
export const FIRSTMATE_CONFIG_FILENAME = "firstmate-annotate.config.json";
/** A finished send stays in the floating pill this long, then only shows in the sidebar. */
const SETTLED_MS = 10_000;

const CSS = `
.wm-fm-status { display: flex; align-items: center; gap: 6px; min-width: 0; color: #57606a; }
.wm-fm-status[data-empty="true"] { display: none; }
.wm-fm-status.wm-fm-failed, .wm-fm-status.wm-fm-no-receipt { color: #d1242f; }
.wm-fm-status.wm-fm-stale { color: #9a6700; }
.wm-fm-status.wm-fm-done { color: #1a7f37; }
.wm-fm-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; box-sizing: border-box; background: #8c959f; }
.wm-fm-dot[data-on="true"] { background: #1a7f37; }
.wm-fm-dot[data-on="false"] { background: transparent; border: 1.5px solid #d1242f; }
.wm-fm-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-note-section[data-section-id="firstmate"] {
  display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #eaeef2; font-size: 12px;
}
.wm-fm-note-state {
  align-self: flex-start; font-size: 11px; padding: 1px 8px; border-radius: 999px;
  background: #f6f8fa; color: #57606a; border: 1px solid #d0d7de;
}
.wm-fm-note-state.wm-fm-working { background: #ddf4ff; color: #0969da; border-color: #b6e3ff; }
.wm-fm-note-state.wm-fm-done { background: #dafbe1; color: #1a7f37; border-color: #aceebb; }
.wm-fm-note-state.wm-fm-failed, .wm-fm-note-state.wm-fm-no-receipt { background: #ffebe9; color: #d1242f; border-color: #ffcecb; }
.wm-fm-note-state.wm-fm-stale { background: #fff8c5; color: #9a6700; border-color: #eed888; }
.wm-fm-reply { border-left: 2px solid #d0d7de; padding-left: 8px; }
.wm-fm-reply:not(.wm-fm-mine) { border-left-color: #0969da; }
.wm-fm-reply-head { font-size: 11px; color: #57606a; margin-bottom: 2px; }
.wm-fm-reply .wm-note-body { font-size: 12.5px; }
.wm-fm-reply .wm-note-body p { margin: 0; }
a.wm-fm-link { font-size: 12px; color: #0969da; }
.wm-fm-reply-form { display: flex; gap: 6px; align-items: flex-end; }
.wm-fm-reply-box {
  flex: 1; min-width: 0; resize: vertical; font: inherit; font-size: 12px; padding: 4px 6px;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328;
}
`;

export function parsePort(input: string | number | null | undefined): number {
  const text = String(input ?? "").trim();
  if (!text) return DEFAULT_RELOAD_PORT;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`port must be 1024-65535: ${text}`);
  return port;
}

/** SSE URL a local doc subscribes to for live reload. */
export function reloadEventsURL(port: number, localPath: string): string {
  return `http://127.0.0.1:${port}/events?path=${encodeURIComponent(localPath)}`;
}

/** Long-poll URL of the status feed for one per-URL folder. */
export function statusFeedURL(port: number, folder: string, since: string, client: string): string {
  return `http://127.0.0.1:${port}/status?folder=${encodeURIComponent(folder)}&since=${encodeURIComponent(since)}&client=${encodeURIComponent(client)}`;
}

/** The part of EventSource live reload uses; injectable for tests. */
export interface ReloadSource {
  addEventListener(type: "reload", listener: () => void): void;
  close(): void;
}

export const FIRSTMATE_FORMAT = "wm-annotate-firstmate";
export const FIRSTMATE_SCHEMA_VERSION = 1;

export interface CaptainReply {
  at: string;
  text: string;
}

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
  /** The captain's replies in this note's thread, oldest first. */
  replies: CaptainReply[];
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

export function captainReplies(annotation: Annotation): CaptainReply[] {
  const replies = annotation.metadata?.[FIRSTMATE_REPLIES_KEY];
  return Array.isArray(replies) ? replies.filter((r) => typeof r?.text === "string" && typeof r?.at === "string") : [];
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
        replies: captainReplies(n),
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
  /**
   * Live reload for docs under the root. Defaults to EventSource and
   * location.reload; `false` disables it.
   */
  liveReload?:
    | false
    | {
        connect(url: string): ReloadSource;
        reload(): void;
      };
  /**
   * GET for the watcher's status feed on 127.0.0.1. Defaults to fetch, which an
   * https page cannot use (Local Network Access blocks it); the userscript passes
   * GM_xmlhttpRequest. `false` turns the live status off.
   */
  request?: FeedRequest | false;
  timers?: Timers;
}

export interface FirstmatePlugin extends AnnotatorPlugin {
  send(): Promise<FirstmateSendResult>;
}

const PROGRESS_TEXT: Record<Progress, string> = {
  sent: "Sent, waiting for the watcher",
  "no-receipt": "No receipt after 10 s. Is the watcher running?",
  received: "Received, waiting for an agent",
  working: "Being worked on",
  stale: "No update for over 10 min",
  done: "Done",
  failed: "Failed",
};

/** The watcher's "received" message only names the inbox id, so it stays in the tooltip. */
function shownMessage(view: ProgressView): string {
  return view.message && view.progress !== "received" ? `: ${view.message}` : "";
}

function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function createFirstmatePlugin(options: FirstmatePluginOptions): FirstmatePlugin {
  let ctx: PluginContext | null = null;
  const cleanups: Array<() => void> = [];

  const ask = options.prompt ?? ((message: string, initial?: string) => globalThis.prompt?.(message, initial) ?? null);
  const notify = options.notify ?? ((message: string) => globalThis.alert?.(message));
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const request: FeedRequest | null =
    options.request === false
      ? null
      : (options.request ??
        (typeof fetch === "function"
          ? async (url: string) => {
              const res = await fetch(url, { cache: "no-store" });
              return { status: res.status, text: await res.text() };
            }
          : null));
  const client = randomId();

  // Live status state for the current page.
  let folder: string | null = null;
  let feed: FirstmateFeed | null = null;
  let connected: boolean | null = null;
  let lastSend: LocalSend | null = null;
  let sentMap: SentMap = {};
  let loop: FeedLoop | null = null;
  let tick: unknown = null;
  let sectionSignature = "";
  const sections = new Map<string, { annotation: Annotation; container: HTMLElement }>();
  const drafts = new Map<string, string>();

  const statusEl = typeof document === "undefined" ? null : document.createElement("div");
  const statusDot = statusEl ? document.createElement("span") : null;
  const statusText = statusEl ? document.createElement("span") : null;
  if (statusEl && statusDot && statusText) {
    // The <style> reaches the whole shadow root, note sections included.
    const style = document.createElement("style");
    style.textContent = CSS;
    statusDot.className = "wm-fm-dot";
    statusText.className = "wm-fm-text";
    statusEl.append(style, statusDot, statusText);
    statusEl.setAttribute("data-quiet", "true");
    statusEl.setAttribute("data-empty", "true");
  }

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("firstmate plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  async function getRoot(): Promise<string[]> {
    const stored = await requireCtx().storage.getSetting?.<string>(FIRSTMATE_ROOT_SETTING);
    return parseRoot(typeof stored === "string" ? stored : null);
  }

  async function getPort(): Promise<number> {
    const stored = await requireCtx().storage.getSetting?.<number>(FIRSTMATE_PORT_SETTING);
    return parsePort(typeof stored === "number" ? stored : null);
  }

  async function getSends(): Promise<Record<string, LocalSend>> {
    const stored = await requireCtx().storage.getSetting?.<Record<string, LocalSend>>(FIRSTMATE_SENDS_SETTING);
    return stored && typeof stored === "object" ? stored : {};
  }

  async function folderOf(page: PageIdentity): Promise<{ folder: string; root: string[]; docPath: string | null }> {
    const root = await getRoot();
    const docPath = docPathOf(page.url, root);
    return { folder: folderFor(page.url, root, docPath), root, docPath };
  }

  const liveReload =
    options.liveReload === false
      ? null
      : (options.liveReload ??
        (typeof EventSource === "function"
          ? {
              connect: (url: string): ReloadSource => new EventSource(url) as unknown as ReloadSource,
              reload: () => globalThis.location.reload(),
            }
          : null));

  /**
   * Subscribe a doc stored under the root: a file:// doc by its path, a doc
   * served from 127.0.0.1 by its path under the root. EventSource retries on its
   * own if the server is down.
   */
  async function startLiveReload(): Promise<void> {
    if (!liveReload) return;
    const url = requireCtx().getPage().url;
    const localPath = localPathOf(url);
    let source: ReloadSource;
    if (localPath) {
      if (!colocatedFolder(localPath, await getRoot())) return;
      source = liveReload.connect(reloadEventsURL(await getPort(), localPath));
    } else {
      const rel = servedDocRel(url);
      if (!rel) return;
      source = liveReload.connect(`${new URL(url).origin}/events?doc=${encodeURIComponent(rel)}`);
    }
    source.addEventListener("reload", () => liveReload.reload());
    cleanups.push(() => source.close());
  }

  // -- live status --------------------------------------------------------------

  const statuses = () => feed?.statuses ?? [];

  function currentSendView(): ProgressView | null {
    return lastSend ? sendProgress(lastSend, statuses(), now()) : null;
  }

  function renderStatus(): void {
    if (!statusEl || !statusDot || !statusText) return;
    const view = currentSendView();
    const settled = !view || ((view.progress === "done" || view.progress === "failed") && now() - view.at > SETTLED_MS);
    statusEl.setAttribute("data-quiet", String(settled));
    let text = "";
    if (view) {
      const count = lastSend?.noteIds.length ?? 0;
      text = `Firstmate: ${PROGRESS_TEXT[view.progress]}${shownMessage(view)}`;
      if (view.progress !== "sent" && view.progress !== "no-receipt") text += ` (${count} note${count === 1 ? "" : "s"})`;
    } else if (connected !== null) {
      text = connected ? "Firstmate connected" : "Firstmate offline, retrying";
    }
    statusEl.setAttribute("data-empty", String(!text));
    if (statusText.textContent !== text) statusText.textContent = text;
    if (statusDot.getAttribute("data-on") !== String(connected)) statusDot.setAttribute("data-on", String(connected));
    const link =
      connected === null ? "" : connected ? "Connected to the firstmate watcher on 127.0.0.1" : "Watcher not reachable on 127.0.0.1; reconnecting";
    statusEl.title = [view?.message, link].filter(Boolean).join("\n");
    statusEl.className = `wm-fm-status wm-fm-${view?.progress ?? (connected ? "connected" : "offline")}`;
  }

  /** A note in a send the watcher has not answered yet shows that send's state. */
  function progressForNote(id: string): ProgressView | null {
    if (lastSend?.noteIds.includes(id) && !statusForSend(lastSend, statuses())) return sendProgress(lastSend, [], now());
    return noteProgress(id, statuses(), now());
  }

  function sectionState(annotation: Annotation): string {
    const p = progressForNote(annotation.id);
    return `${annotation.id}:${annotation.updatedAt}:${p?.progress}:${p?.message}`;
  }

  /** Redraw every visible note section when what it shows has changed. */
  function refreshSections(force = false): void {
    for (const [id, entry] of sections) if (!entry.container.isConnected) sections.delete(id);
    const signature = [...sections.values()].map((e) => sectionState(e.annotation)).join("|") + (feed?.version ?? "") + Object.keys(sentMap).length;
    if (!force && signature === sectionSignature) return;
    sectionSignature = signature;
    for (const entry of sections.values()) drawSection(entry.annotation, entry.container);
  }

  function update(): void {
    renderStatus();
    refreshSections();
    const view = currentSendView();
    const active = view && !((view.progress === "done" || view.progress === "failed") && now() - view.at > SETTLED_MS);
    const working = statuses().some((s) => s.state === "assigned");
    if (!active && !working) {
      if (tick !== null) timers.clear(tick);
      tick = null;
      return;
    }
    if (tick === null) {
      const loopTick = () => {
        tick = null;
        update();
      };
      tick = timers.set(loopTick, 1000);
    }
  }

  async function connectFeed(): Promise<void> {
    if (!request || loop || !folder) return;
    const port = await getPort();
    const target = folder;
    loop = startFeed({
      request,
      timers,
      url: (since) => statusFeedURL(port, target, since, client),
      onFeed: (next) => {
        feed = next;
        update();
      },
      onConnection: (on) => {
        if (connected === on) return;
        connected = on;
        renderStatus();
      },
    });
  }

  function disconnectFeed(): void {
    loop?.stop();
    loop = null;
    feed = null;
    connected = null;
  }

  /** Connect when this page is a doc under the root or has sent before. */
  async function startLiveStatus(): Promise<void> {
    const c = requireCtx();
    const info = await folderOf(c.getPage());
    folder = info.folder;
    sentMap = ((await c.storage.getSetting?.<SentMap>(FIRSTMATE_SENT_SETTING)) ?? {}) as SentMap;
    lastSend = (await getSends())[info.folder] ?? null;
    const isDoc = !!info.docPath && !!colocatedFolder(info.docPath, info.root);
    if (lastSend || isDoc) await connectFeed();
    update();
  }

  // -- note threads ---------------------------------------------------------------

  const el = <K extends keyof HTMLElementTagNameMap>(container: HTMLElement, tag: K, className?: string, text?: string) => {
    const node = container.ownerDocument.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function drawSection(annotation: Annotation, container: HTMLElement): void {
    const root = container.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement;
    const hadFocus = !!active && container.contains(active) && active.tagName === "TEXTAREA";
    container.textContent = "";

    const progress = progressForNote(annotation.id);
    const theirs = repliesFor(annotation.id, statuses()).map((r) => ({ ...r, mine: false }));
    const mine = captainReplies(annotation).map((r) => ({ noteId: annotation.id, author: "you", at: r.at, text: r.text, link: null, done: false, mine: true }));
    const thread = [...theirs, ...mine].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const wasSent = annotation.id in sentMap;
    if (!progress && !thread.length && !wasSent) return;

    if (progress) {
      const badge = el(container, "div", `wm-fm-note-state wm-fm-${progress.progress}`);
      const label = progress.progress === "received" ? "Queued" : PROGRESS_TEXT[progress.progress];
      // A reply that closed the note is shown in full just below.
      const closedByReply = progress.progress === "done" && theirs.some((r) => r.done);
      badge.textContent = `${label}${closedByReply ? "" : shownMessage(progress)}`;
      badge.title = [progress.message, progress.at ? `Updated ${relativeTime(now() - progress.at)}` : ""].filter(Boolean).join("\n");
      container.appendChild(badge);
    }

    const pageUrl = requireCtx().getPage().url;
    const fromFile = pageUrl.startsWith("file:");
    void Promise.all([getRoot(), getPort()]).then(([rootSegments, port]) => {
      for (const a of container.querySelectorAll<HTMLAnchorElement>("a[data-link]")) {
        const href = replyHref(a.dataset.link, rootSegments, port, fromFile);
        if (href) a.href = href;
        else a.replaceWith(el(container, "code", "wm-fm-link", a.dataset.link));
      }
    });

    for (const entry of thread) {
      const item = el(container, "div", entry.mine ? "wm-fm-reply wm-fm-mine" : "wm-fm-reply");
      const head = el(container, "div", "wm-fm-reply-head", `${entry.author} · ${relativeTime(now() - Date.parse(entry.at))}${entry.done ? " · done" : ""}`);
      const body = el(container, "div", "wm-note-body");
      body.innerHTML = renderMarkdown(entry.text); // renderMarkdown escapes all input
      item.append(head, body);
      if (entry.link) {
        const link = el(container, "a", "wm-fm-link", "Open ↗");
        link.dataset.link = entry.link;
        link.target = "_blank";
        link.rel = "noopener";
        item.appendChild(link);
      }
      container.appendChild(item);
    }

    if (!wasSent) return;
    const form = el(container, "div", "wm-fm-reply-form");
    const box = el(container, "textarea", "wm-fm-reply-box");
    box.rows = 1;
    box.placeholder = "Reply to firstmate…";
    box.setAttribute("aria-label", "Reply to firstmate on this note");
    box.value = drafts.get(annotation.id) ?? "";
    // Keys typed here must reach neither the page nor the annotator's shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) box.addEventListener(type, (e) => e.stopPropagation());
    box.addEventListener("input", () => drafts.set(annotation.id, box.value));
    const submit = el(container, "button", "wm-btn", "Reply");
    submit.type = "button";
    const post = () => void reply(annotation.id, box.value);
    submit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      post();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        post();
      }
    });
    form.append(box, submit);
    container.appendChild(form);
    if (hadFocus) box.focus();
  }

  /** Add the captain's reply to the note's thread and send it through the normal path. */
  async function reply(noteId: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const c = requireCtx();
    const existing = await c.storage.get(noteId);
    if (!existing) return;
    const replies = [...captainReplies(existing), { at: new Date(now()).toISOString(), text: body }];
    drafts.delete(noteId);
    await c.annotator.updateNote(noteId, { metadata: { ...existing.metadata, [FIRSTMATE_REPLIES_KEY]: replies } });
    try {
      await send();
    } catch (err) {
      notify(`Reply saved but not sent to firstmate: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -- send -------------------------------------------------------------------------

  async function send(): Promise<FirstmateSendResult> {
    const c = requireCtx();
    const page = c.getPage();
    const sent = ((await c.storage.getSetting?.<SentMap>(FIRSTMATE_SENT_SETTING)) ?? {}) as SentMap;
    const pending = unsentNotes(await c.storage.getPage(page), sent);
    if (!pending.length) return { sent: 0, path: null };

    const { folder: target, root } = await folderOf(page);
    const reloadPort = await getPort();
    const at = now();
    const filename = firstmateFilename(at);
    const path = `${target}/${filename}`;
    await options.save(
      FIRSTMATE_CONFIG_FILENAME,
      JSON.stringify({ format: "wm-annotate-firstmate-config", root: root.join("/"), reloadPort }, null, 2) + "\n",
      { overwrite: true }
    );
    await options.save(path, JSON.stringify(buildFirstmatePayload(page, pending, at, target), null, 2), {
      overwrite: false,
    });
    sentMap = markSent(sent, pending);
    await c.storage.setSetting?.(FIRSTMATE_SENT_SETTING, sentMap);
    const record: LocalSend = { source: filename, sentAt: at, noteIds: pending.map((n) => n.id) };
    await c.storage.setSetting?.(FIRSTMATE_SENDS_SETTING, { ...(await getSends()), [target]: record });
    if (target === folder) {
      lastSend = record;
      await connectFeed();
      update();
      refreshSections(true);
      // The indicator must turn to "no receipt" on time even with nothing else happening.
      timers.set(update, NO_RECEIPT_MS + 50);
    }
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

  async function configurePort(): Promise<void> {
    const c = requireCtx();
    const entered = ask(
      `Live-reload port the watcher serves on 127.0.0.1 (1024-65535). Blank resets to ${DEFAULT_RELOAD_PORT}. ` +
        "Restart the watcher after a send so it reads the new port.",
      String(await getPort())
    );
    if (entered === null) return;
    try {
      await c.storage.setSetting?.(FIRSTMATE_PORT_SETTING, parsePort(entered));
    } catch (err) {
      notify(`Port not saved: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** The live indicator reports a send; only a page without one gets a dialog. */
  const run = (): void => {
    void send()
      .then((result) => {
        if (!result.path) notify("No new or edited notes on this page to send to firstmate.");
        else if (!statusEl || !request) {
          notify(`Sent ${result.sent} note${result.sent === 1 ? "" : "s"} to firstmate: Downloads/${result.path}`);
        }
      })
      .catch((err) => notify(`Send to firstmate failed: ${err instanceof Error ? err.message : err}`));
  };

  const plugin: FirstmatePlugin = {
    name: "firstmate",

    setup(pluginCtx) {
      ctx = pluginCtx;
      cleanups.push(pluginCtx.commands.register("firstmate.send", () => run()));
      cleanups.push(pluginCtx.commands.register("firstmate.configure-root", () => configureRoot()));
      cleanups.push(pluginCtx.commands.register("firstmate.configure-port", () => configurePort()));
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
              { label: "Reload port…", onClick: () => void configurePort() },
            ];
            return entries;
          },
        })
      );
      if (statusEl) cleanups.push(pluginCtx.addStatusItem(statusEl));
      cleanups.push(
        pluginCtx.addNoteSection({
          id: "firstmate",
          render: (annotation, container) => {
            sections.set(annotation.id, { annotation, container });
            drawSection(annotation, container);
          },
        })
      );
      cleanups.push(
        pluginCtx.on("page:change", () => {
          disconnectFeed();
          lastSend = null;
          void startLiveStatus().catch((err) => console.warn("[webmods-annotate] firstmate status not started", err));
        })
      );
      cleanups.push(() => {
        disconnectFeed();
        if (tick !== null) timers.clear(tick);
      });
      void startLiveReload().catch((err) => console.warn("[webmods-annotate] live reload not started", err));
      void startLiveStatus().catch((err) => console.warn("[webmods-annotate] firstmate status not started", err));
    },

    destroy() {
      for (const off of cleanups.splice(0)) off();
      ctx = null;
    },

    send,
  };

  return plugin;
}
