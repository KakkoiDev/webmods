#!/usr/bin/env node
// Watch a folder for firstmate-annotate-*.json files saved by the annotate
// userscript's "Send to firstmate" action. Each file becomes one firstmate inbox
// note (`fm-inbox.sh note --request-id <sha256> -`), then moves to processed/.
// The request id is the file's sha256, so re-running on the same file replays the
// original note instead of creating a second one.
//
// Usage: firstmate-drop-watch.mjs [--dir <folder>] [--fm-root <path>] [--once] [--interval <ms>]
//   --dir       folder to watch; env FIRSTMATE_DROP_DIR; default ~/Downloads
//   --fm-root   firstmate checkout holding bin/fm-inbox.sh; env FM_ROOT; required
//   --once      process what is there now and exit (exit 1 if any file failed)
//   --interval  poll interval in ms, default 2000
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DROP_PATTERN = /^firstmate-annotate-.*\.json$/;
export const FORMAT = "wm-annotate-firstmate";

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

export function renderMarkdown(payload, filename) {
  const { page, notes } = payload;
  const count = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
  const lines = [`# Annotate feedback: ${page.title || page.url}`, ""];
  lines.push(`- Page: ${page.url}`);
  if (page.localPath) lines.push(`- Document: \`${page.localPath}\``);
  lines.push(`- Sent: ${payload.sentAt}`, `- Notes: ${count}`);
  if (filename) lines.push(`- Source file: ${filename}`);
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
    const dest = moveInto(join(file, "..", "rejected"), file, digest);
    log(`rejected ${basename(file)}: ${err.message} -> ${dest}`);
    return "rejected";
  }
  const result = spawnSync(join(fmRoot, "bin", "fm-inbox.sh"), ["note", "--request-id", digest, "-"], {
    input: renderMarkdown(payload, basename(file)),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    log(`failed ${basename(file)}: fm-inbox.sh exited ${result.status}${detail ? `: ${detail}` : ""}`);
    return "failed";
  }
  const dest = moveInto(join(file, "..", "processed"), file, digest);
  log(`sent ${basename(file)} (${payload.notes.length} notes, ${result.stdout.trim()}) -> ${dest}`);
  return "sent";
}

export function scanOnce(dir, options) {
  const outcomes = [];
  for (const name of readdirSync(dir).sort()) {
    if (!DROP_PATTERN.test(name)) continue;
    try {
      outcomes.push(processFile(join(dir, name), options));
    } catch (err) {
      // A file removed or renamed between readdir and read must not kill the watcher.
      (options.log ?? console.error)(`failed ${name}: ${err.message}`);
      outcomes.push("failed");
    }
  }
  return outcomes;
}

function parseArgs(argv) {
  const args = { dir: process.env.FIRSTMATE_DROP_DIR, fmRoot: process.env.FM_ROOT, once: false, interval: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--once") args.once = true;
    else if (flag === "--dir") args.dir = argv[++i];
    else if (flag === "--fm-root") args.fmRoot = argv[++i];
    else if (flag === "--interval") args.interval = Number(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  args.dir ||= join(homedir(), "Downloads");
  if (!args.fmRoot) throw new Error("set FM_ROOT or pass --fm-root <firstmate checkout>");
  if (!existsSync(join(args.fmRoot, "bin", "fm-inbox.sh"))) throw new Error(`no bin/fm-inbox.sh under ${args.fmRoot}`);
  if (!(args.interval > 0)) throw new Error("--interval must be a positive number of ms");
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
  if (args.once) {
    process.exit(scanOnce(args.dir, options).includes("failed") ? 1 : 0);
  }
  console.error(`watching ${args.dir} for firstmate-annotate-*.json every ${args.interval}ms`);
  scanOnce(args.dir, options);
  setInterval(() => scanOnce(args.dir, options), args.interval);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
