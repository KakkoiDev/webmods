// @vitest-environment node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRoot,
  inboxIdOf,
  isDropPath,
  renderMarkdown,
  resolveRoot,
  scanOnce,
  servedDocPath,
} from "../bin/firstmate-drop-watch.mjs";

const WATCHER = join(__dirname, "..", "bin", "firstmate-drop-watch.mjs");

const payload = {
  format: "wm-annotate-firstmate",
  schemaVersion: 1,
  sentAt: "2026-09-28T03:20:53.123Z",
  folder: "firstmate-annotate/file/work-plan.html",
  page: { url: "file:///work/plan.html", title: "Plan", localPath: "/work/plan.html" },
  notes: [
    {
      id: "n1",
      anchor: { kind: "range", selector: "#intro > p", quote: "two\nlines", prefix: null, suffix: null },
      body: "Tighten **this**.",
      createdAt: "2026-09-28T03:00:00.000Z",
      updatedAt: "2026-09-28T03:10:00.000Z",
    },
    {
      id: "n2",
      anchor: { kind: "block", selector: null, quote: null, prefix: null, suffix: null },
      body: "Whole block note.",
      createdAt: "2026-09-28T03:01:00.000Z",
      updatedAt: "2026-09-28T03:01:00.000Z",
    },
  ],
};

const expectedMarkdown = `# Annotate feedback: Plan

- Page: file:///work/plan.html
- Document: \`/work/plan.html\`
- Folder: \`/dl/firstmate-annotate/file/work-plan.html\`
- Sent: 2026-09-28T03:20:53.123Z
- Notes: 2 notes
- Source file: firstmate-annotate-x.json

## Note 1 of 2

- Note id: n1
- Anchor: range \`#intro > p\`
- Created: 2026-09-28T03:00:00.000Z, updated: 2026-09-28T03:10:00.000Z

> two
> lines

Tighten **this**.

## Note 2 of 2

- Note id: n2
- Anchor: block
- Created: 2026-09-28T03:01:00.000Z, updated: 2026-09-28T03:01:00.000Z

Whole block note.
`;

// Stub fm-inbox.sh: records each call and dedupes by request id like the real one.
const STUB = `#!/usr/bin/env bash
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$here/fail" ] && { echo "stub failure" >&2; exit 1; }
[ "$1" = note ] && [ "$2" = --request-id ] && [ "$4" = - ] || { echo "bad args: $*" >&2; exit 2; }
mkdir -p "$here/notes"
if [ -f "$here/notes/$3" ]; then echo "replay fm-$3"; exit 0; fi
cat > "$here/notes/$3"
echo "queued fm-$3"
`;

let root: string;
let drop: string;
let fmRoot: string;
const logs: string[] = [];
const options = () => ({ fmRoot, log: (m: string) => logs.push(m) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fm-drop-"));
  drop = join(root, "downloads");
  fmRoot = join(root, "fm");
  mkdirSync(drop);
  mkdirSync(join(fmRoot, "bin"), { recursive: true });
  writeFileSync(join(fmRoot, "bin", "fm-inbox.sh"), STUB);
  chmodSync(join(fmRoot, "bin", "fm-inbox.sh"), 0o755);
  logs.length = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("renderMarkdown", () => {
  it("renders page, document path, folder and every note", () => {
    expect(renderMarkdown(payload, "/dl/firstmate-annotate/file/work-plan.html/firstmate-annotate-x.json")).toBe(
      expectedMarkdown
    );
  });
});

describe("root resolution", () => {
  it("prefers the explicit root, then the userscript's config file, then the default", () => {
    expect(resolveRoot(drop, undefined)).toBe("firstmate-annotate");
    writeFileSync(join(drop, "firstmate-annotate.config.json"), JSON.stringify({ root: "team/notes" }));
    expect(resolveRoot(drop, undefined)).toBe("team/notes");
    expect(resolveRoot(drop, "other")).toBe("other");
  });

  it("refuses roots that could leave the Downloads folder", () => {
    for (const bad of ["/abs", "../x", "a/./b", ".hidden", "A B"]) expect(() => checkRoot(bad)).toThrow("invalid root");
    writeFileSync(join(drop, "firstmate-annotate.config.json"), JSON.stringify({ root: "../../up" }));
    expect(() => resolveRoot(drop, undefined)).toThrow("invalid root");
  });
});

describe("scanOnce", () => {
  const text = JSON.stringify(payload);
  const digest = createHash("sha256").update(text).digest("hex");
  const name = "firstmate-annotate-20260928T032053.123Z.json";
  let folder: string;
  let tree: string;

  beforeEach(() => {
    tree = join(drop, "firstmate-annotate");
    folder = join(tree, "example.com", "guide-intro.html");
    mkdirSync(folder, { recursive: true });
  });

  it("finds drop files in nested per-URL folders, sends each once, and moves it to processed/ beside it", () => {
    writeFileSync(join(folder, name), text);
    writeFileSync(join(folder, "doc.html"), "<p>doc</p>");

    expect(scanOnce(tree, options())).toEqual(["sent"]);
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
    expect(readFileSync(join(fmRoot, "notes", digest), "utf8")).toContain(`- Folder: \`${folder}\``);
    expect(existsSync(join(folder, name))).toBe(false);
    expect(existsSync(join(folder, "processed", name))).toBe(true);
    expect(existsSync(join(folder, "doc.html"))).toBe(true);

    expect(scanOnce(tree, options())).toEqual([]);
  });

  it("is idempotent: the same file dropped again replays instead of adding a note", () => {
    writeFileSync(join(folder, name), text);
    scanOnce(tree, options());
    writeFileSync(join(folder, name), text);

    expect(scanOnce(tree, options())).toEqual(["sent"]);
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
    expect(logs[1]).toContain("replay");
    expect(readdirSync(join(folder, "processed")).sort()).toEqual([
      `firstmate-annotate-20260928T032053.123Z.${digest.slice(0, 12)}.json`,
      name,
    ]);
  });

  it("leaves the file in place when fm-inbox.sh fails, and sends it on the next scan", () => {
    writeFileSync(join(folder, name), text);
    writeFileSync(join(fmRoot, "fail"), "");
    expect(scanOnce(tree, options())).toEqual(["failed"]);
    expect(existsSync(join(folder, name))).toBe(true);
    expect(logs[0]).toContain("stub failure");

    rmSync(join(fmRoot, "fail"));
    expect(scanOnce(tree, options())).toEqual(["sent"]);
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
  });

  it("moves an unreadable file to rejected/ beside it without calling fm-inbox.sh", () => {
    writeFileSync(join(folder, name), "{not json");
    expect(scanOnce(tree, options())).toEqual(["rejected"]);
    expect(existsSync(join(folder, "rejected", name))).toBe(true);
    expect(existsSync(join(fmRoot, "notes"))).toBe(false);
  });
  const statusFile = () => join(folder, "status", `${digest}.json`);
  const readStatus = () => JSON.parse(readFileSync(statusFile(), "utf8"));
  const at = () => Date.UTC(2026, 8, 28, 7, 0, 0);

  it("writes a received status beside the notes, naming the inbox id and the notes it covers", () => {
    writeFileSync(join(folder, name), text);
    scanOnce(tree, { ...options(), now: at });
    expect(readStatus()).toEqual({
      format: "wm-annotate-firstmate-status",
      schemaVersion: 1,
      requestId: digest,
      state: "received",
      at: "2026-09-28T07:00:00.000Z",
      message: `Delivered to firstmate as inbox note fm-${digest}`,
      source: name,
      inboxId: `fm-${digest}`,
      sentAt: payload.sentAt,
      noteIds: ["n1", "n2"],
      replies: [],
    });
    const note = readFileSync(join(fmRoot, "notes", digest), "utf8");
    expect(note).toContain(`- Status file: \`${statusFile()}\``);
    expect(note).toContain("- Note id: n1");
    expect(readdirSync(join(folder, "status"))).toEqual([`${digest}.json`]);
  });

  it("writes failed while fm-inbox.sh fails, then received once it succeeds", () => {
    writeFileSync(join(folder, name), text);
    writeFileSync(join(fmRoot, "fail"), "");
    scanOnce(tree, options());
    expect(readStatus()).toMatchObject({ state: "failed", message: "Not delivered, retrying: fm-inbox.sh exited 1: stub failure" });
    rmSync(join(fmRoot, "fail"));
    scanOnce(tree, options());
    expect(readStatus()).toMatchObject({ state: "received", inboxId: `fm-${digest}` });
  });

  it("never resets firstmate's progress when the same file is dropped again", () => {
    writeFileSync(join(folder, name), text);
    scanOnce(tree, options());
    const assigned = { ...readStatus(), state: "assigned", message: "Tightening the intro", at: "2026-09-28T07:05:00.000Z" };
    writeFileSync(statusFile(), JSON.stringify(assigned));
    writeFileSync(join(folder, name), text);
    scanOnce(tree, options());
    expect(readStatus()).toEqual(assigned);
  });

  it("records a rejected file as a failed status", () => {
    writeFileSync(join(folder, name), "{not json");
    scanOnce(tree, options());
    const [file] = readdirSync(join(folder, "status"));
    const status = JSON.parse(readFileSync(join(folder, "status", file), "utf8"));
    expect(status).toMatchObject({ state: "failed", source: name, noteIds: [] });
    expect(status.message).toMatch(/^Rejected: /);
  });

  it("names the document of a page served from the 127.0.0.1 server", () => {
    const served = { ...payload, page: { url: "http://127.0.0.1:4817/doc/docs/plan/doc.html", title: "Plan", localPath: null } };
    writeFileSync(join(folder, name), JSON.stringify(served));
    scanOnce(tree, options());
    const [id] = readdirSync(join(fmRoot, "notes"));
    expect(readFileSync(join(fmRoot, "notes", id), "utf8")).toContain(`- Document: \`${join(tree, "docs", "plan", "doc.html")}\``);
  });
});

describe("helpers", () => {
  it("resolves served docs under the root only", () => {
    expect(servedDocPath("http://127.0.0.1:4817/doc/docs/a%20b/doc.html?x=1", "/dl/root")).toBe("/dl/root/docs/a b/doc.html");
    expect(servedDocPath("http://localhost:5000/doc/x.html", "/dl/root")).toBe("/dl/root/x.html");
    expect(servedDocPath("http://127.0.0.1:4817/doc/..%2F..%2Foutside.txt", "/dl/root")).toBeNull();
    expect(servedDocPath("https://example.com/doc/x.html", "/dl/root")).toBeNull();
  });

  it("reads the inbox id fm-inbox.sh prints and spots drop files by path", () => {
    expect(inboxIdOf("queued 1790581097-abc\n  summary\n")).toBe("1790581097-abc");
    expect(inboxIdOf("replay 17-x\n")).toBe("17-x");
    expect(inboxIdOf("something else")).toBeNull();
    expect(isDropPath("example.com/a/firstmate-annotate-1.json")).toBe(true);
    expect(isDropPath("example.com/a/processed/firstmate-annotate-1.json")).toBe(false);
    expect(isDropPath("example.com/a/status/abc.json")).toBe(false);
    expect(isDropPath("example.com/a/doc.html")).toBe(false);
  });
});

describe("watcher CLI instant pickup", () => {
  it("delivers a new drop through fs.watch long before the fallback rescan", async () => {
    const folder = join(drop, "firstmate-annotate", "example.com", "a");
    mkdirSync(folder, { recursive: true });
    // The fallback rescan is a minute away, so only fs.watch can deliver in time.
    const child = spawn("node", [WATCHER, "--downloads", drop, "--no-reload", "--interval", "60000"], {
      env: { ...process.env, FM_ROOT: fmRoot },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const until = async (check: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error(`timed out; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      await until(() => stderr.includes("watching"), 5000);
      await new Promise((r) => setTimeout(r, 300));
      const written = Date.now();
      writeFileSync(join(folder, "firstmate-annotate-20260928T070000.000Z.json"), JSON.stringify(payload));
      await until(() => existsSync(join(fmRoot, "notes")) && readdirSync(join(fmRoot, "notes")).length === 1, 3000);
      const elapsed = Date.now() - written;
      expect(elapsed).toBeLessThan(1500);
      await until(() => /ms after write\)/.test(stderr), 2000);
      console.log(`instant pickup: note delivered ${elapsed}ms after write; watcher log: ${stderr.match(/\d+ms after write/)?.[0]}`);
    } finally {
      child.kill();
    }
  });
});

describe("watcher CLI end to end", () => {
  it("reads the root from the config file, delivers a nested drop once, and dedupes the replay", () => {
    writeFileSync(join(drop, "firstmate-annotate.config.json"), JSON.stringify({ root: "team/notes" }));
    const folder = join(drop, "team", "notes", "localhost-8080", "plan");
    mkdirSync(folder, { recursive: true });
    const text = JSON.stringify(payload);
    const digest = createHash("sha256").update(text).digest("hex");
    const name = "firstmate-annotate-20260928T050000.000Z.json";
    writeFileSync(join(folder, name), text);
    // A drop outside the configured root is not the watcher's business.
    writeFileSync(join(drop, name), text);

    const run = () =>
      execFileSync("node", [WATCHER, "--once", "--downloads", drop], {
        env: { ...process.env, FM_ROOT: fmRoot },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    run();
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
    expect(readFileSync(join(fmRoot, "notes", digest), "utf8")).toContain(`- Folder: \`${folder}\``);
    expect(existsSync(join(folder, "processed", name))).toBe(true);
    expect(existsSync(join(drop, name))).toBe(true);

    writeFileSync(join(folder, name), text);
    run();
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
    expect(readdirSync(join(folder, "processed"))).toHaveLength(2);
  });

  it("exits 1 with --once when a delivery fails, and 2 without FM_ROOT", () => {
    const folder = join(drop, "firstmate-annotate", "example.com", "index");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "firstmate-annotate-1.json"), JSON.stringify(payload));
    writeFileSync(join(fmRoot, "fail"), "");
    const env = { ...process.env, FM_ROOT: fmRoot };
    expect(spawnSync("node", [WATCHER, "--once", "--downloads", drop], { env }).status).toBe(1);
    const { FM_ROOT: _unset, ...noRoot } = env;
    expect(spawnSync("node", [WATCHER, "--once", "--downloads", drop], { env: noRoot }).status).toBe(2);
  });
});
