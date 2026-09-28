// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown, scanOnce } from "../bin/firstmate-drop-watch.mjs";

const payload = {
  format: "wm-annotate-firstmate",
  schemaVersion: 1,
  sentAt: "2026-09-28T03:20:53.123Z",
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
- Sent: 2026-09-28T03:20:53.123Z
- Notes: 2 notes
- Source file: firstmate-annotate-x.json

## Note 1 of 2

- Anchor: range \`#intro > p\`
- Created: 2026-09-28T03:00:00.000Z, updated: 2026-09-28T03:10:00.000Z

> two
> lines

Tighten **this**.

## Note 2 of 2

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
if [ -f "$here/notes/$3" ]; then echo replay; exit 0; fi
cat > "$here/notes/$3"
echo created
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
  it("renders page, document path and every note", () => {
    expect(renderMarkdown(payload, "firstmate-annotate-x.json")).toBe(expectedMarkdown);
  });
});

describe("scanOnce", () => {
  const text = JSON.stringify(payload);
  const digest = createHash("sha256").update(text).digest("hex");
  const name = "firstmate-annotate-20260928T032053.123Z.json";

  it("turns a drop file into one note keyed by its sha256, then moves it to processed/", () => {
    writeFileSync(join(drop, name), text);
    writeFileSync(join(drop, "unrelated.json"), "{}");

    expect(scanOnce(drop, options())).toEqual(["sent"]);
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
    expect(readFileSync(join(fmRoot, "notes", digest), "utf8")).toBe(renderMarkdown(payload, name));
    expect(existsSync(join(drop, name))).toBe(false);
    expect(existsSync(join(drop, "processed", name))).toBe(true);
    expect(existsSync(join(drop, "unrelated.json"))).toBe(true);
  });

  it("is idempotent: the same file dropped again replays instead of adding a note", () => {
    writeFileSync(join(drop, name), text);
    scanOnce(drop, options());
    writeFileSync(join(drop, name), text);

    expect(scanOnce(drop, options())).toEqual(["sent"]);
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
    expect(logs[1]).toContain("replay");
    expect(readdirSync(join(drop, "processed")).sort()).toEqual([
      `firstmate-annotate-20260928T032053.123Z.${digest.slice(0, 12)}.json`,
      name,
    ]);
  });

  it("leaves the file in place when fm-inbox.sh fails, and sends it on the next scan", () => {
    writeFileSync(join(drop, name), text);
    writeFileSync(join(fmRoot, "fail"), "");
    expect(scanOnce(drop, options())).toEqual(["failed"]);
    expect(existsSync(join(drop, name))).toBe(true);
    expect(logs[0]).toContain("stub failure");

    rmSync(join(fmRoot, "fail"));
    expect(scanOnce(drop, options())).toEqual(["sent"]);
    expect(readdirSync(join(fmRoot, "notes"))).toEqual([digest]);
  });

  it("moves an unreadable file to rejected/ without calling fm-inbox.sh", () => {
    writeFileSync(join(drop, name), "{not json");
    expect(scanOnce(drop, options())).toEqual(["rejected"]);
    expect(existsSync(join(drop, "rejected", name))).toBe(true);
    expect(existsSync(join(fmRoot, "notes"))).toBe(false);
  });
});
