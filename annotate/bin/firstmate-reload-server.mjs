// The watcher's 127.0.0.1 server. Pages always open the connection; the server
// never dials a browser.
//
// GET /events?path=<absolute file path> | ?doc=<path under the root>  ->  text/event-stream
//   Live reload: `event: reload` with data {"path": "..."} after the file changes (debounced).
// GET /status?folder=<per-URL folder>&since=<version>&client=<page id>  ->  JSON feed
//   Long poll: answers at once when the folder's status files differ from `since`,
//   else holds up to 25 s for a change. Every open poll counts as a live page.
// GET /presence  ->  JSON list of per-URL folders with a live page.
// GET /doc/<path under the root>  ->  the file, so a reply link opens from any page.
//
// SSE for reload because a file:// page can open an EventSource to 127.0.0.1.
// An https page cannot (Chrome's Local Network Access blocks it), so the status
// feed is plain long-poll JSON the userscript fetches through GM_xmlhttpRequest.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

export const DEFAULT_PORT = 4817;
export const HOST = "127.0.0.1";
export const FEED_FORMAT = "wm-annotate-firstmate-feed";
export const PRESENCE_FORMAT = "wm-annotate-firstmate-presence";
const RELOADABLE = /\.html?$/i;
const STATUS_FILE = /[\\/]status[\\/]([^\\/.][^\\/]*)\.json$/;
const RETRY_MS = 1000;
const KEEPALIVE_MS = 25_000;
/** A page between two polls still counts as present for this long. */
export const PRESENCE_GRACE_MS = 5000;
const CLEAN_SEGMENT = /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Hash of the file's bytes, or null when it cannot be read (deleted, mid-rename). */
function contentHash(path) {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function canonical(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export function createReloadServer({
  port = DEFAULT_PORT,
  debounceMs = 300,
  statusDebounceMs = 30,
  pollMs = 25_000,
  log = console.error,
  now = Date.now,
} = {}) {
  const clients = new Map();
  const timers = new Map();
  // Content each subscribed file had when last pushed (or when first subscribed).
  // A change event whose content matches is dropped: macOS FSEvents replays
  // events from before the watch started, and one burst can arrive as two batches.
  const baselines = new Map();
  /** folder -> Set of waiting long polls. */
  const polls = new Map();
  /** folder -> Map(client -> { since, lastSeen, open }). */
  const presence = new Map();
  let watcher = null;
  let watchedDir = null;
  let lastWatchError = null;
  let downloadsDir = null;
  let rootRel = null;
  let listenPort = null;

  /**
   * DNS rebinding guard: a request must name this server as its Host, so a site
   * whose hostname resolves to 127.0.0.1 cannot read the feed or the docs.
   */
  function allowedHost(host) {
    if (host === undefined) return true;
    return host === `${HOST}:${listenPort}` || host === `localhost:${listenPort}`;
  }

  /** Reload: file:// pages (Origin "null"), docs this server serves, and local tools (no Origin). */
  function allowedReloadOrigin(origin) {
    return origin === undefined || origin === "null" || origin === `http://${HOST}:${listenPort}` || origin === `http://localhost:${listenPort}`;
  }

  /** Absolute path of `rel` under the root, or null when it would leave the root. */
  function underRoot(rel) {
    if (!downloadsDir || !rootRel) return null;
    const rootDir = join(downloadsDir, rootRel);
    const path = resolve(rootDir, rel);
    return path.startsWith(rootDir + sep) ? path : null;
  }

  /** A per-URL folder, relative to Downloads, that sits under the root and has only clean segments. */
  function folderDir(folder) {
    if (!rootRel || typeof folder !== "string") return null;
    const segments = folder.split("/");
    if (!folder.startsWith(`${rootRel}/`) || !segments.every((s) => CLEAN_SEGMENT.test(s))) return null;
    return join(downloadsDir, ...segments);
  }

  function readFeed(folder) {
    const dir = join(folderDir(folder), "status");
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
    } catch {
      // No status folder yet: nothing was delivered from this page.
    }
    const hash = createHash("sha1");
    const statuses = [];
    for (const name of names) {
      let text;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      hash.update(name).update("\0").update(text).update("\0");
      try {
        statuses.push({ ...JSON.parse(text), requestId: name.slice(0, -".json".length) });
      } catch {
        // A half-written file; the rename that completes it triggers another read.
      }
    }
    return {
      format: FEED_FORMAT,
      schemaVersion: 1,
      folder,
      version: hash.digest("hex").slice(0, 16),
      now: new Date(now()).toISOString(),
      statuses,
    };
  }

  function touchPresence(folder, client, delta) {
    const map = presence.get(folder) ?? new Map();
    presence.set(folder, map);
    const entry = map.get(client) ?? { since: now(), lastSeen: now(), open: 0 };
    entry.open += delta;
    entry.lastSeen = now();
    map.set(client, entry);
  }

  function presenceSnapshot() {
    const at = now();
    const folders = [];
    for (const [folder, map] of presence) {
      for (const [client, entry] of map) {
        if (entry.open <= 0 && at - entry.lastSeen > PRESENCE_GRACE_MS) map.delete(client);
      }
      if (!map.size) {
        presence.delete(folder);
        continue;
      }
      const entries = [...map.values()];
      folders.push({
        folder,
        pages: map.size,
        since: new Date(Math.min(...entries.map((e) => e.since))).toISOString(),
        lastSeen: new Date(Math.max(...entries.map((e) => (e.open > 0 ? at : e.lastSeen)))).toISOString(),
      });
    }
    return { format: PRESENCE_FORMAT, schemaVersion: 1, now: new Date(at).toISOString(), folders: folders.sort((a, b) => a.folder.localeCompare(b.folder)) };
  }

  function servePoll(req, res, url) {
    const folder = url.searchParams.get("folder");
    if (!folderDir(folder)) {
      json(res, 400, { error: "folder must be a per-URL folder under the root" });
      return;
    }
    const since = url.searchParams.get("since");
    const client = (url.searchParams.get("client") || "anonymous").slice(0, 64);
    // Only a file:// page may read this from page script; the userscript reads it
    // through GM_xmlhttpRequest, which CORS does not apply to.
    const cors = req.headers.origin === "null" ? { "access-control-allow-origin": "null" } : {};
    touchPresence(folder, client, 1);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(waiter.timer);
      polls.get(folder)?.delete(waiter);
      touchPresence(folder, client, -1);
    };
    const waiter = {
      since,
      respond: (feed) => {
        if (done) return;
        json(res, 200, feed, cors);
        finish();
      },
      timer: null,
    };
    res.on("close", finish);
    const feed = readFeed(folder);
    if (feed.version !== since) {
      waiter.respond(feed);
      return;
    }
    waiter.timer = setTimeout(() => waiter.respond(readFeed(folder)), pollMs);
    const set = polls.get(folder) ?? new Set();
    set.add(waiter);
    polls.set(folder, set);
  }

  function serveDoc(res, rel) {
    const path = underRoot(rel);
    if (!path || path.split(sep).some((s) => s.startsWith("."))) {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
      body = readFileSync(path);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  function serveEvents(req, res, url) {
    const origin = req.headers.origin;
    if (!allowedReloadOrigin(origin)) {
      res.writeHead(403).end();
      return;
    }
    const doc = url.searchParams.get("doc");
    const path = doc ? underRoot(doc) : url.searchParams.get("path");
    if (!path || !path.startsWith("/")) {
      res.writeHead(400).end(doc ? "doc must be a path under the root" : "path must be an absolute file path");
      return;
    }
    const key = canonical(path);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...(origin === "null" ? { "access-control-allow-origin": "null" } : {}),
    });
    res.write(`retry: ${RETRY_MS}\n: subscribed ${key}\n\n`);
    const set = clients.get(key) ?? new Set();
    set.add(res);
    clients.set(key, set);
    if (!baselines.has(key)) baselines.set(key, contentHash(key));
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    res.on("close", () => {
      clearInterval(keepalive);
      set.delete(res);
      if (!set.size) {
        clients.delete(key);
        baselines.delete(key);
      }
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (req.method !== "GET" || !allowedHost(req.headers.host)) {
      res.writeHead(req.method !== "GET" ? 404 : 403).end();
      return;
    }
    if (url.pathname === "/events") serveEvents(req, res, url);
    else if (url.pathname === "/status") servePoll(req, res, url);
    else if (url.pathname === "/presence") json(res, 200, presenceSnapshot());
    else if (url.pathname.startsWith("/doc/")) {
      let rel;
      try {
        rel = decodeURIComponent(url.pathname.slice("/doc/".length));
      } catch {
        res.writeHead(400).end();
        return;
      }
      serveDoc(res, rel);
    } else res.writeHead(404).end();
  });

  function broadcast(key) {
    const set = clients.get(key);
    if (!set?.size) return 0;
    const hash = contentHash(key);
    if (hash === baselines.get(key)) return 0;
    baselines.set(key, hash);
    const message = `event: reload\ndata: ${JSON.stringify({ path: key })}\n\n`;
    for (const res of set) res.write(message);
    log(`reload ${key} -> ${set.size} page${set.size === 1 ? "" : "s"}`);
    return set.size;
  }

  /** Answer every poll on `folder` whose version is now out of date. */
  function pushFolder(folder) {
    const set = polls.get(folder);
    if (!set?.size) return;
    const feed = readFeed(folder);
    for (const waiter of [...set]) if (waiter.since !== feed.version) waiter.respond(feed);
  }

  function debounce(key, ms, run) {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run();
      }, ms)
    );
  }

  /**
   * Record a change to `path`. An HTML file is checked once per burst within
   * `debounceMs` and reloads only if its content changed; a status file pushes
   * the feed of its per-URL folder.
   */
  function notifyChange(path) {
    const status = STATUS_FILE.exec(path);
    if (status && downloadsDir) {
      const dir = resolve(path, "..", "..");
      const folder = dir.startsWith(downloadsDir + sep) ? dir.slice(downloadsDir.length + 1).split(sep).join("/") : null;
      if (folder && polls.has(folder)) debounce(`status:${folder}`, statusDebounceMs, () => pushFolder(folder));
      return;
    }
    if (!RELOADABLE.test(path)) return;
    const key = canonical(path);
    debounce(key, debounceMs, () => broadcast(key));
  }

  /** The Downloads folder and the root under it, for /status, /doc and ?doc=. */
  function setRoot(downloads, root) {
    downloadsDir = resolve(downloads);
    rootRel = root;
  }

  /** Watch `dir` recursively and feed every change to notifyChange, replacing any previous watch. */
  function watchDir(dir) {
    if (dir === watchedDir) return;
    watcher?.close();
    watcher = null;
    watchedDir = dir;
    try {
      watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) notifyChange(join(dir, filename.toString()));
      });
      watcher.on("error", (err) => log(`reload watch error on ${dir}: ${err.message}`));
      lastWatchError = null;
    } catch (err) {
      // The root does not exist until the first send creates it; the caller retries.
      watchedDir = null;
      if (err.message !== lastWatchError) log(`reload watch not started on ${dir}: ${err.message}`);
      lastWatchError = err.message;
    }
  }

  return {
    notifyChange,
    watchDir,
    setRoot,
    presence: presenceSnapshot,
    subscribers: (path) => clients.get(canonical(path))?.size ?? 0,
    waiting: (folder) => polls.get(folder)?.size ?? 0,
    address: () => server.address(),
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
          listenPort = server.address().port;
          resolveListen(listenPort);
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        watcher?.close();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        for (const set of clients.values()) for (const res of set) res.end();
        clients.clear();
        for (const set of polls.values()) for (const waiter of set) clearTimeout(waiter.timer);
        polls.clear();
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}
