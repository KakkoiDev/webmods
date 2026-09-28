// Live reload for local docs: a Server-Sent Events endpoint on 127.0.0.1 that
// tells every open copy of a file:// page to reload when that file changes on disk.
//
// GET /events?path=<absolute file path>  ->  text/event-stream
//   `event: reload` with data {"path": "..."} after the file changes (debounced).
//
// SSE rather than WebSocket: the push is one-way, node:http serves it with no
// dependency, and the browser's EventSource reconnects on its own after a restart.
import { realpathSync, watch } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

export const DEFAULT_PORT = 4817;
export const HOST = "127.0.0.1";
const RELOADABLE = /\.html?$/i;
const RETRY_MS = 1000;
const KEEPALIVE_MS = 25_000;

function canonical(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Only file:// pages (Origin "null") and non-browser clients (no Origin) may
 * subscribe, so a website open in the same browser cannot listen in.
 */
function allowedOrigin(origin) {
  return origin === undefined || origin === "null";
}

export function createReloadServer({ port = DEFAULT_PORT, debounceMs = 300, log = console.error } = {}) {
  const clients = new Map();
  const timers = new Map();
  let watcher = null;
  let watchedDir = null;
  let lastWatchError = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const origin = req.headers.origin;
    if (req.method !== "GET" || url.pathname !== "/events") {
      res.writeHead(404).end();
      return;
    }
    if (!allowedOrigin(origin)) {
      res.writeHead(403).end();
      return;
    }
    const path = url.searchParams.get("path");
    if (!path || !path.startsWith("/")) {
      res.writeHead(400).end("path must be an absolute file path");
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
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    req.on("close", () => {
      clearInterval(keepalive);
      set.delete(res);
      if (!set.size) clients.delete(key);
    });
  });

  function broadcast(key) {
    const set = clients.get(key);
    if (!set?.size) return 0;
    const message = `event: reload\ndata: ${JSON.stringify({ path: key })}\n\n`;
    for (const res of set) res.write(message);
    log(`reload ${key} -> ${set.size} page${set.size === 1 ? "" : "s"}`);
    return set.size;
  }

  /** Record a change to `path`; bursts of writes within `debounceMs` send one reload. */
  function notifyChange(path) {
    if (!RELOADABLE.test(path)) return;
    const key = canonical(path);
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        broadcast(key);
      }, debounceMs)
    );
  }

  /** Watch `dir` recursively for HTML changes, replacing any previous watch. */
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
      // The root does not exist until the first send creates it; the caller retries every scan.
      watchedDir = null;
      if (err.message !== lastWatchError) log(`reload watch not started on ${dir}: ${err.message}`);
      lastWatchError = err.message;
    }
  }

  return {
    notifyChange,
    watchDir,
    subscribers: (path) => clients.get(canonical(path))?.size ?? 0,
    address: () => server.address(),
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => resolveListen(server.address().port));
      }),
    close: () =>
      new Promise((resolveClose) => {
        watcher?.close();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        for (const set of clients.values()) for (const res of set) res.end();
        clients.clear();
        server.close(() => resolveClose());
      }),
  };
}
