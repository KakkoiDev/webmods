/**
 * The page side of the watcher's status contract: what the status files say
 * about a send and about each note, and the long-poll loop that keeps them live.
 * The file format itself is documented in the README ("Status files").
 */

export const STATUS_FORMAT = "wm-annotate-firstmate-status";
/** An "assigned" status whose `at` is older than this shows as stale, not working. */
export const STALE_AFTER_MS = 10 * 60_000;
/** A send with no status after this long shows the "no receipt" warning. */
export const NO_RECEIPT_MS = 10_000;
/** Reconnect delays: 0.5 s, 1 s, 2 s, 4 s, then every 5 s. */
export const BACKOFF_MAX_MS = 5000;

export interface FirstmateReply {
  noteId: string;
  author: string;
  at: string;
  text: string;
  link?: string | null;
  done?: boolean;
}

export interface FirstmateStatus {
  requestId: string;
  state: "received" | "assigned" | "done" | "failed" | string;
  at: string;
  message?: string;
  source?: string;
  inboxId?: string | null;
  sentAt?: string | null;
  noteIds?: string[];
  replies?: FirstmateReply[];
}

export interface FirstmateFeed {
  format: string;
  schemaVersion: number;
  folder: string;
  version: string;
  now: string;
  statuses: FirstmateStatus[];
}

/** A send this browser made, kept per folder so the indicator survives a reload. */
export interface LocalSend {
  source: string;
  sentAt: number;
  noteIds: string[];
}

export type Progress = "sent" | "no-receipt" | "received" | "working" | "stale" | "done" | "failed";

export interface ProgressView {
  progress: Progress;
  message: string;
  /** When the status (or the send) last changed, ms since epoch. */
  at: number;
}

const time = (iso: string | null | undefined): number => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
};

export function progressOf(status: FirstmateStatus, now: number): Progress {
  if (status.state === "done") return "done";
  if (status.state === "failed") return "failed";
  if (status.state === "assigned") return now - time(status.at) > STALE_AFTER_MS ? "stale" : "working";
  return "received";
}

function view(status: FirstmateStatus, now: number): ProgressView {
  return { progress: progressOf(status, now), message: status.message ?? "", at: time(status.at) };
}

/** The status the watcher wrote for `send`: same source file, or same sentAt when the file was renamed. */
export function statusForSend(send: LocalSend, statuses: FirstmateStatus[]): FirstmateStatus | null {
  const sentAt = new Date(send.sentAt).toISOString();
  return statuses.find((s) => s.source === send.source) ?? statuses.find((s) => s.sentAt === sentAt) ?? null;
}

export function sendProgress(send: LocalSend, statuses: FirstmateStatus[], now: number): ProgressView {
  const status = statusForSend(send, statuses);
  if (status) return view(status, now);
  return now - send.sentAt >= NO_RECEIPT_MS
    ? { progress: "no-receipt", message: "", at: send.sentAt }
    : { progress: "sent", message: "", at: send.sentAt };
}

/** Firstmate's replies to one note across every status in the folder, oldest first. */
export function repliesFor(noteId: string, statuses: FirstmateStatus[]): FirstmateReply[] {
  return statuses
    .flatMap((s) => (Array.isArray(s.replies) ? s.replies : []))
    .filter((r) => r && r.noteId === noteId && typeof r.text === "string")
    .sort((a, b) => time(a.at) - time(b.at));
}

/**
 * A note's state: that of the newest status carrying it, unless a later reply
 * with `done: true` closed it. Null when no status mentions the note.
 */
export function noteProgress(noteId: string, statuses: FirstmateStatus[], now: number): ProgressView | null {
  const carrying = statuses
    .filter((s) => Array.isArray(s.noteIds) && s.noteIds.includes(noteId))
    .sort((a, b) => time(a.sentAt ?? a.at) - time(b.sentAt ?? b.at));
  const latest = carrying[carrying.length - 1] ?? null;
  const closing = repliesFor(noteId, statuses).filter((r) => r.done).pop();
  if (closing && (!latest || time(closing.at) >= time(latest.sentAt ?? latest.at))) {
    return { progress: "done", message: closing.text.split("\n")[0], at: time(closing.at) };
  }
  return latest ? view(latest, now) : null;
}

/** Segments of `path` after its last run of `root` segments, or null when it is not under the root. */
export function pathUnderRoot(path: string, root: string[]): string[] | null {
  const parts = path.split("/").filter(Boolean);
  for (let at = parts.length - root.length - 1; at >= 0; at--) {
    if (!root.every((segment, i) => parts[at + i] === segment)) continue;
    const rest = parts.slice(at + root.length);
    return rest.length && rest.every((s) => s !== "." && s !== "..") ? rest : null;
  }
  return null;
}

/**
 * Where a reply link should point. A path or file:// URL under the root becomes
 * the 127.0.0.1 server's /doc/ URL, which an https page can open (a file:// link
 * from a web page is blocked). http(s) links pass through. Anything else is not
 * linked, except a file:// link from a file:// page, which the browser allows.
 */
export function replyHref(link: string | null | undefined, root: string[], port: number, fromFilePage: boolean): string | null {
  if (!link) return null;
  let path: string | null = null;
  if (link.startsWith("/")) path = link;
  else {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    if (url.protocol !== "file:") return null;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  const rest = pathUnderRoot(path, root);
  if (rest) return `http://127.0.0.1:${port}/doc/${rest.map(encodeURIComponent).join("/")}`;
  return fromFilePage ? `file://${path.split("/").map(encodeURIComponent).join("/")}` : null;
}

export interface FeedResponse {
  status: number;
  text: string;
}

/** One HTTP GET; resolves with any status, rejects when the server cannot be reached. */
export type FeedRequest = (url: string) => Promise<FeedResponse>;

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, 500 * 2 ** Math.max(0, failures - 1));
}

export interface FeedLoop {
  stop(): void;
}

/**
 * Long-poll the feed until stopped. Each answer re-polls at once with its
 * version; a failure reports disconnected and retries with backoff, so the page
 * picks up again by itself after a watcher restart.
 */
export function startFeed(options: {
  request: FeedRequest;
  url(since: string): string;
  onFeed(feed: FirstmateFeed): void;
  onConnection(connected: boolean): void;
  timers?: Timers;
}): FeedLoop {
  const timers = options.timers ?? realTimers;
  let since = "";
  let failures = 0;
  let stopped = false;
  let handle: unknown = null;

  const next = (ms: number) => {
    if (!stopped) handle = timers.set(() => void poll(), ms);
  };

  async function poll(): Promise<void> {
    if (stopped) return;
    let feed: FirstmateFeed;
    try {
      const response = await options.request(options.url(since));
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      feed = JSON.parse(response.text) as FirstmateFeed;
      if (!Array.isArray(feed?.statuses) || typeof feed.version !== "string") throw new Error("not a status feed");
    } catch {
      if (stopped) return;
      // A restarted server would hold a poll carrying the last version until
      // something changes; without one it answers at once.
      since = "";
      failures++;
      options.onConnection(false);
      next(backoffMs(failures));
      return;
    }
    if (stopped) return;
    failures = 0;
    options.onConnection(true);
    if (feed.version !== since) {
      since = feed.version;
      options.onFeed(feed);
    }
    next(0);
  }

  next(0);
  return {
    stop() {
      stopped = true;
      timers.clear(handle);
    },
  };
}
