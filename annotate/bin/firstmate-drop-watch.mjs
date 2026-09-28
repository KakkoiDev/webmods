#!/usr/bin/env node
// Watch the annotate userscript's send folder for firstmate-annotate-*.json files.
// Sends land in <downloads>/<root>/<host>/<path-slug>/ (or next to a local doc),
// so the tree under <downloads>/<root> is watched and scanned recursively. Each
// file becomes one firstmate inbox note (`fm-inbox.sh note --request-id <sha256> -`),
// then moves to a processed/ folder beside it, and a status/<sha256>.json file
// records the delivery for the page. The request id is the file's sha256, so
// re-running on the same file replays the original note instead of adding one.
//
// While watching (not --once) it also serves live reload, the status feed, and
// docs under the root: see firstmate-reload-server.mjs.
//
// Usage: firstmate-drop-watch.mjs [--downloads <dir>] [--root <rel>] [--fm-root <path>] [--once] [--interval <ms>]
//                                 [--port <n>] [--no-reload]
//   --downloads  browser download folder; env FIRSTMATE_DOWNLOADS; default ~/Downloads
//   --root       send folder relative to --downloads; env FIRSTMATE_ROOT; default: the
//                "root" in <downloads>/firstmate-annotate.config.json, which the
//                userscript rewrites on every send, else "firstmate-annotate"
//   --fm-root    firstmate checkout holding bin/fm-inbox.sh; env FM_ROOT; required
//   --once       process what is there now and exit (exit 1 if any file failed)
//   --interval   fallback rescan interval in ms, default 2000; new files are picked
//                up at once through fs.watch
//   --port       server port on 127.0.0.1; env FIRSTMATE_RELOAD_PORT; default: the
//                "reloadPort" in the config file, else 4817. Read once at startup.
//   --no-reload  do not start the 127.0.0.1 server
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_PORT, createReloadServer } from "./firstmate-reload-server.mjs";

export const DROP_PATTERN = /^firstmate-annotate-.*\.json$/;
export const FORMAT = "wm-annotate-firstmate";
export const STATUS_FORMAT = "wm-annotate-firstmate-status";
export const STATUS_SCHEMA_VERSION = 1;
export const CONFIG_FILENAME = "firstmate-annotate.config.json";
export const DEFAULT_ROOT = "firstmate-annotate";
const SKIP_DIRS = new Set(["processed", "rejected", "status"]);
const MAX_DEPTH = 8;
const PICKUP_DEBOUNCE_MS = 25;
/** A doc the 127.0.0.1 server serves: http://127.0.0.1:<port>/doc/<path under the root>. */
const SERVED_DOC = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/doc\/(.+)$/;

/** Same rule as the userscript's parseRoot: relative, clean segments, no "." or "..". */
export function checkRoot(root) {
  const segments = String(root).split("/").filter(Boolean);
  const clean = /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/;
  if (String(root).startsWith("/") || !segments.length || !segments.every((s) => clean.test(s))) {
    throw new Error(`invalid root "${root}": use a relative path of a-z, 0-9, ".", "_", "-" segments`);
  }
  return segments.join("/");
}

function readConfig(downloads) {
  const configPath = join(downloads, CONFIG_FILENAME);
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
}

export function checkPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`invalid port "${port}": use 1024-65535`);
  return n;
}

/** --root/env wins; else the config file the userscript writes; else the default. */
export function resolveRoot(downloads, explicit) {
  if (explicit) return checkRoot(explicit);
  return checkRoot(readConfig(downloads)?.root || DEFAULT_ROOT);
}

/** --port/env wins; else the config file; else DEFAULT_PORT. */
export function resolvePort(downloads, explicit) {
  if (explicit) return checkPort(explicit);
  return checkPort(readConfig(downloads)?.reloadPort ?? DEFAULT_PORT);
}

export function parsePayload(text) {
  const payload = JSON.parse(text);
  if (payload?.format !== FORMAT) throw new Error(`not a ${FORMAT} file`);
  if (!payload.page || typeof payload.page.url !== "string") throw new Error("missing page.url");
  if (!Array.isArray(payload.notes)) throw new Error("missing notes[]");
  return payload;
}

function quote(text) {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** Absolute path of a doc served from under `rootDir`, or null when `url` is not one. */
export function servedDocPath(url, rootDir) {
  const match = SERVED_DOC.exec(url.split(/[?#]/)[0]);
  if (!match || !rootDir) return null;
  let rel;
  try {
    rel = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const path = resolve(rootDir, rel);
  return path.startsWith(rootDir + sep) ? path : null;
}

export function statusPathFor(file, requestId) {
  return join(dirname(file), "status", `${requestId}.json`);
}

/**
 * `file` is the absolute path of the drop file; its directory is the per-URL folder.
 * `rootDir` resolves the document path of a doc served from the 127.0.0.1 server.
 */
export function renderMarkdown(payload, file, { requestId = null, rootDir = null } = {}) {
  const { page, notes } = payload;
  const count = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
  const localPath = page.localPath || servedDocPath(page.url, rootDir);
  const lines = [`# Annotate feedback: ${page.title || page.url}`, ""];
  lines.push(`- Page: ${page.url}`);
  if (localPath) lines.push(`- Document: \`${localPath}\``);
  lines.push(`- Folder: \`${dirname(file)}\``);
  lines.push(`- Sent: ${payload.sentAt}`, `- Notes: ${count}`, `- Source file: ${basename(file)}`);
  if (requestId) lines.push(`- Status file: \`${statusPathFor(file, requestId)}\``);
  notes.forEach((note, i) => {
    const anchor = note.anchor ?? {};
    lines.push("", `## Note ${i + 1} of ${notes.length}`, "");
    lines.push(`- Note id: ${note.id}`);
    lines.push(`- Anchor: ${anchor.kind ?? "block"}${anchor.selector ? ` \`${anchor.selector}\`` : ""}`);
    lines.push(`- Created: ${note.createdAt}, updated: ${note.updatedAt}`);
    if (anchor.quote) lines.push("", quote(anchor.quote));
    lines.push("", note.body ?? "");
    const replies = Array.isArray(note.replies) ? note.replies : [];
    if (replies.length) {
      lines.push("", "### Captain's replies (newest last)", "");
      for (const reply of replies) lines.push(`- ${reply.at}: ${String(reply.text ?? "").replace(/\n/g, " ")}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

function moveInto(dir, file, digest) {
  mkdirSync(dir, { recursive: true });
  let dest = join(dir, basename(file));
  if (existsSync(dest)) dest = join(dir, `${basename(file, extname(file))}.${digest.slice(0, 12)}${extname(file)}`);
  renameSync(file, dest);
  return dest;
}

function readStatus(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the watcher's status for one drop file, through a temp file and a rename
 * so a reader never sees half a file. The watcher only writes while the file is
 * missing or still in a watcher "failed" state: once firstmate has taken over
 * ("received" onward), a replay of the same drop file must not reset its progress.
 * Returns true when it wrote.
 */
export function writeWatcherStatus(file, requestId, fields, now = Date.now) {
  const path = statusPathFor(file, requestId);
  const existing = readStatus(path);
  if (existing && existing.state !== "failed") return false;
  if (existing && fields.state === "failed" && existing.message === fields.message) return false;
  const status = {
    format: STATUS_FORMAT,
    schemaVersion: STATUS_SCHEMA_VERSION,
    requestId,
    at: new Date(now()).toISOString(),
    source: basename(file),
    replies: [],
    ...fields,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${requestId}.json.tmp`);
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(tmp, path);
  return true;
}

/** The inbox id from fm-inbox.sh's first line: "queued <id>" or "replay <id>". */
export function inboxIdOf(stdout) {
  return /^(?:queued|replay)\s+(\S+)/m.exec(stdout ?? "")?.[1] ?? null;
}

/** Returns "sent", "rejected" or "failed". A failed file stays in place for the next scan. */
export function processFile(file, { fmRoot, rootDir = null, log = console.error, now = Date.now }) {
  const bytes = readFileSync(file);
  const writtenAt = statSync(file).mtimeMs;
  const digest = createHash("sha256").update(bytes).digest("hex");
  let payload;
  try {
    payload = parsePayload(bytes.toString("utf8"));
  } catch (err) {
    writeWatcherStatus(file, digest, { state: "failed", message: `Rejected: ${err.message}`, noteIds: [] }, now);
    const dest = moveInto(join(dirname(file), "rejected"), file, digest);
    log(`rejected ${file}: ${err.message} -> ${dest}`);
    return "rejected";
  }
  const noteIds = payload.notes.map((n) => n?.id).filter((id) => typeof id === "string");
  const result = spawnSync(join(fmRoot, "bin", "fm-inbox.sh"), ["note", "--request-id", digest, "-"], {
    input: renderMarkdown(payload, file, { requestId: digest, rootDir }),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    const reason = `fm-inbox.sh exited ${result.status}${detail ? `: ${detail.split("\n")[0]}` : ""}`;
    writeWatcherStatus(
      file,
      digest,
      { state: "failed", message: `Not delivered, retrying: ${reason}`, sentAt: payload.sentAt ?? null, noteIds },
      now
    );
    log(`failed ${file}: fm-inbox.sh exited ${result.status}${detail ? `: ${detail}` : ""}`);
    return "failed";
  }
  const inboxId = inboxIdOf(result.stdout);
  writeWatcherStatus(
    file,
    digest,
    {
      state: "received",
      message: inboxId ? `Delivered to firstmate as inbox note ${inboxId}` : "Delivered to firstmate",
      inboxId,
      sentAt: payload.sentAt ?? null,
      noteIds,
    },
    now
  );
  const latency = Math.round(now() - writtenAt);
  const dest = moveInto(join(dirname(file), "processed"), file, digest);
  log(`sent ${file} (${payload.notes.length} notes, ${result.stdout.trim().split("\n")[0]}, ${latency}ms after write) -> ${dest}`);
  return "sent";
}

/** Drop files under `dir`, skipping processed/, rejected/ and status/ folders. */
export function findDropFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH || !existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) found.push(...findDropFiles(path, depth + 1));
    else if (entry.isFile() && DROP_PATTERN.test(entry.name)) found.push(path);
  }
  return found;
}

export function scanOnce(dir, options) {
  const outcomes = [];
  for (const file of findDropFiles(dir)) {
    try {
      outcomes.push(processFile(file, { rootDir: dir, ...options }));
    } catch (err) {
      // A file removed or renamed between readdir and read must not kill the watcher.
      (options.log ?? console.error)(`failed ${file}: ${err.message}`);
      outcomes.push("failed");
    }
  }
  return outcomes;
}

/** True when a changed path (relative to the root) is a drop file the scan would pick up. */
export function isDropPath(rel) {
  const parts = rel.split(/[\\/]/);
  return DROP_PATTERN.test(parts[parts.length - 1]) && !parts.slice(0, -1).some((p) => SKIP_DIRS.has(p));
}

/**
 * Watch `dir` recursively and call `onPath(absolutePath)` for every change.
 * Returns the watcher, or null when `dir` does not exist yet.
 */
export function watchTree(dir, onPath, log = console.error) {
  try {
    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) onPath(join(dir, filename.toString()));
    });
    watcher.on("error", (err) => log(`watch error on ${dir}: ${err.message}`));
    return watcher;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    downloads: process.env.FIRSTMATE_DOWNLOADS,
    root: process.env.FIRSTMATE_ROOT,
    fmRoot: process.env.FM_ROOT,
    port: process.env.FIRSTMATE_RELOAD_PORT,
    reload: true,
    once: false,
    interval: 2000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--once") args.once = true;
    else if (flag === "--downloads") args.downloads = argv[++i];
    else if (flag === "--root") args.root = argv[++i];
    else if (flag === "--fm-root") args.fmRoot = argv[++i];
    else if (flag === "--interval") args.interval = Number(argv[++i]);
    else if (flag === "--port") args.port = argv[++i];
    else if (flag === "--no-reload") args.reload = false;
    else throw new Error(`unknown argument: ${flag}`);
  }
  args.downloads ||= join(homedir(), "Downloads");
  if (!args.fmRoot) throw new Error("set FM_ROOT or pass --fm-root <firstmate checkout>");
  if (!existsSync(join(args.fmRoot, "bin", "fm-inbox.sh"))) throw new Error(`no bin/fm-inbox.sh under ${args.fmRoot}`);
  if (!(args.interval > 0)) throw new Error("--interval must be a positive number of ms");
  if (args.root) checkRoot(args.root);
  if (args.port) checkPort(args.port);
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`firstmate-drop-watch: ${err.message}`);
    process.exit(2);
  }
  const options = { fmRoot: args.fmRoot };
  let server = null;
  if (!args.once && args.reload) {
    try {
      server = createReloadServer({ port: resolvePort(args.downloads, args.port) });
      const port = await server.listen();
      console.error(`live reload and status feed on http://127.0.0.1:${port}`);
    } catch (err) {
      console.error(`firstmate-drop-watch: server not started: ${err.message}`);
      process.exit(2);
    }
  }
  let watching = null;
  let tree = null;
  let pickup = null;
  const scan = () => {
    let root;
    try {
      root = resolveRoot(args.downloads, args.root);
    } catch (err) {
      console.error(`firstmate-drop-watch: ${err.message}`);
      return ["failed"];
    }
    const dir = join(args.downloads, root);
    if (dir !== watching) {
      console.error(`watching ${dir} for firstmate-annotate-*.json`);
      tree?.close();
      tree = null;
      watching = dir;
      server?.setRoot(args.downloads, root);
    }
    // The root does not exist until the first send creates it; retry every scan.
    if (!args.once && !tree) {
      tree = watchTree(dir, (path) => {
        server?.notifyChange(path);
        if (!isDropPath(relative(dir, path))) return;
        clearTimeout(pickup);
        pickup = setTimeout(scan, PICKUP_DEBOUNCE_MS);
      });
    }
    return scanOnce(dir, options);
  };
  if (args.once) process.exit(scan().includes("failed") ? 1 : 0);
  scan();
  setInterval(scan, args.interval);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
