#!/usr/bin/env node
// Watch the annotate userscript's send folder for firstmate-annotate-*.json files.
// Sends land in <downloads>/<root>/<host>/<path-slug>/ (or next to a local doc),
// so the tree under <downloads>/<root> is scanned recursively. Each file becomes
// one firstmate inbox note (`fm-inbox.sh note --request-id <sha256> -`), then
// moves to a processed/ folder beside it. The request id is the file's sha256, so
// re-running on the same file replays the original note instead of adding one.
//
// Usage: firstmate-drop-watch.mjs [--downloads <dir>] [--root <rel>] [--fm-root <path>] [--once] [--interval <ms>]
//   --downloads  browser download folder; env FIRSTMATE_DOWNLOADS; default ~/Downloads
//   --root       send folder relative to --downloads; env FIRSTMATE_ROOT; default: the
//                "root" in <downloads>/firstmate-annotate.config.json, which the
//                userscript rewrites on every send, else "firstmate-annotate"
//   --fm-root    firstmate checkout holding bin/fm-inbox.sh; env FM_ROOT; required
//   --once       process what is there now and exit (exit 1 if any file failed)
//   --interval   poll interval in ms, default 2000
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DROP_PATTERN = /^firstmate-annotate-.*\.json$/;
export const FORMAT = "wm-annotate-firstmate";
export const CONFIG_FILENAME = "firstmate-annotate.config.json";
export const DEFAULT_ROOT = "firstmate-annotate";
const SKIP_DIRS = new Set(["processed", "rejected"]);
const MAX_DEPTH = 8;

/** Same rule as the userscript's parseRoot: relative, clean segments, no "." or "..". */
export function checkRoot(root) {
  const segments = String(root).split("/").filter(Boolean);
  const clean = /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/;
  if (String(root).startsWith("/") || !segments.length || !segments.every((s) => clean.test(s))) {
    throw new Error(`invalid root "${root}": use a relative path of a-z, 0-9, ".", "_", "-" segments`);
  }
  return segments.join("/");
}

/** --root/env wins; else the config file the userscript writes; else the default. */
export function resolveRoot(downloads, explicit) {
  if (explicit) return checkRoot(explicit);
  const configPath = join(downloads, CONFIG_FILENAME);
  if (!existsSync(configPath)) return DEFAULT_ROOT;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return checkRoot(config?.root || DEFAULT_ROOT);
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

/** `file` is the absolute path of the drop file; its directory is the per-URL folder. */
export function renderMarkdown(payload, file) {
  const { page, notes } = payload;
  const count = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
  const lines = [`# Annotate feedback: ${page.title || page.url}`, ""];
  lines.push(`- Page: ${page.url}`);
  if (page.localPath) lines.push(`- Document: \`${page.localPath}\``);
  lines.push(`- Folder: \`${dirname(file)}\``);
  lines.push(`- Sent: ${payload.sentAt}`, `- Notes: ${count}`, `- Source file: ${basename(file)}`);
  notes.forEach((note, i) => {
    const anchor = note.anchor ?? {};
    lines.push("", `## Note ${i + 1} of ${notes.length}`, "");
    lines.push(`- Anchor: ${anchor.kind ?? "block"}${anchor.selector ? ` \`${anchor.selector}\`` : ""}`);
    lines.push(`- Created: ${note.createdAt}, updated: ${note.updatedAt}`);
    if (anchor.quote) lines.push("", quote(anchor.quote));
    lines.push("", note.body ?? "");
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

/** Returns "sent", "rejected" or "failed". A failed file stays in place for the next scan. */
export function processFile(file, { fmRoot, log = console.error }) {
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let payload;
  try {
    payload = parsePayload(bytes.toString("utf8"));
  } catch (err) {
    const dest = moveInto(join(dirname(file), "rejected"), file, digest);
    log(`rejected ${file}: ${err.message} -> ${dest}`);
    return "rejected";
  }
  const result = spawnSync(join(fmRoot, "bin", "fm-inbox.sh"), ["note", "--request-id", digest, "-"], {
    input: renderMarkdown(payload, file),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    log(`failed ${file}: fm-inbox.sh exited ${result.status}${detail ? `: ${detail}` : ""}`);
    return "failed";
  }
  const dest = moveInto(join(dirname(file), "processed"), file, digest);
  log(`sent ${file} (${payload.notes.length} notes, ${result.stdout.trim()}) -> ${dest}`);
  return "sent";
}

/** Drop files under `dir`, skipping processed/ and rejected/ folders. */
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
      outcomes.push(processFile(file, options));
    } catch (err) {
      // A file removed or renamed between readdir and read must not kill the watcher.
      (options.log ?? console.error)(`failed ${file}: ${err.message}`);
      outcomes.push("failed");
    }
  }
  return outcomes;
}

function parseArgs(argv) {
  const args = {
    downloads: process.env.FIRSTMATE_DOWNLOADS,
    root: process.env.FIRSTMATE_ROOT,
    fmRoot: process.env.FM_ROOT,
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
    else throw new Error(`unknown argument: ${flag}`);
  }
  args.downloads ||= join(homedir(), "Downloads");
  if (!args.fmRoot) throw new Error("set FM_ROOT or pass --fm-root <firstmate checkout>");
  if (!existsSync(join(args.fmRoot, "bin", "fm-inbox.sh"))) throw new Error(`no bin/fm-inbox.sh under ${args.fmRoot}`);
  if (!(args.interval > 0)) throw new Error("--interval must be a positive number of ms");
  if (args.root) checkRoot(args.root);
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`firstmate-drop-watch: ${err.message}`);
    process.exit(2);
  }
  const options = { fmRoot: args.fmRoot };
  let watching = null;
  const scan = () => {
    let root;
    try {
      root = resolveRoot(args.downloads, args.root);
    } catch (err) {
      console.error(`firstmate-drop-watch: ${err.message}`);
      return ["failed"];
    }
    const dir = join(args.downloads, root);
    if (dir !== watching) console.error(`watching ${dir} for firstmate-annotate-*.json`);
    watching = dir;
    return scanOnce(dir, options);
  };
  if (args.once) process.exit(scan().includes("failed") ? 1 : 0);
  scan();
  setInterval(scan, args.interval);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
