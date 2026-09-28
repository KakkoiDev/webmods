// @vitest-environment node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRESENCE_GRACE_MS, createReloadServer } from "../bin/firstmate-reload-server.mjs";

const WATCHER = join(__dirname, "..", "bin", "firstmate-drop-watch.mjs");
const FOLDER = "firstmate-annotate/example.com/a";

let downloads: string;
let folderDir: string;
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  downloads = mkdtempSync(join(tmpdir(), "fm-feed-"));
  folderDir = join(downloads, ...FOLDER.split("/"));
  mkdirSync(join(folderDir, "status"), { recursive: true });
});

afterEach(async () => {
  for (const off of cleanups.splice(0).reverse()) await off();
  rmSync(downloads, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** GET that resolves on the full response; `abort()` drops the connection like a closed tab. */
function fetchText(port: number, path: string, headers: Record<string, string> = {}) {
  let abort = () => {};
  const done = new Promise<Reply>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
    abort = () => req.destroy();
    cleanups.push(() => req.destroy());
  });
  done.catch(() => {});
  return { done, abort: () => abort() };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeStatus(requestId: string, fields: Record<string, unknown>) {
  const status = { format: "wm-annotate-firstmate-status", schemaVersion: 1, requestId, at: "2026-09-28T07:00:00.000Z", ...fields };
  writeFileSync(join(folderDir, "status", `${requestId}.json`), JSON.stringify(status));
}

async function start(opts: { pollMs?: number; now?: () => number } = {}) {
  const server = createReloadServer({ port: 0, debounceMs: 50, statusDebounceMs: 10, log: () => {}, ...opts });
  const port = await server.listen();
  server.setRoot(downloads, "firstmate-annotate");
  cleanups.push(() => server.close());
  return { server, port };
}

const poll = (port: number, since = "", client = "page-1") =>
  fetchText(port, `/status?folder=${encodeURIComponent(FOLDER)}&since=${since}&client=${client}`);

describe("status feed", () => {
  it("answers at once with every status in the folder, named by its file", async () => {
    const { port } = await start();
    writeStatus("aaa", { state: "received", message: "Delivered", requestId: "stale-inside-file" });
    writeStatus("bbb", { state: "assigned", message: "Fixing the intro" });
    writeFileSync(join(folderDir, "status", ".ccc.json.tmp"), "{half");
    const reply = await poll(port).done;
    expect(reply.status).toBe(200);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    const feed = JSON.parse(reply.body);
    expect(feed).toMatchObject({ format: "wm-annotate-firstmate-feed", schemaVersion: 1, folder: FOLDER });
    expect(feed.statuses.map((s: { requestId: string; state: string }) => [s.requestId, s.state])).toEqual([
      ["aaa", "received"],
      ["bbb", "assigned"],
    ]);
    expect(feed.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("holds a poll that is up to date and pushes as soon as a status file changes", async () => {
    const { server, port } = await start();
    server.watchDir(join(downloads, "firstmate-annotate"));
    writeStatus("aaa", { state: "received", message: "Delivered" });
    const first = JSON.parse((await poll(port).done).body);

    const held = poll(port, first.version);
    await until(() => server.waiting(FOLDER) === 1);
    await sleep(150);
    let answered = false;
    void held.done.then(() => (answered = true));
    await sleep(100);
    expect(answered).toBe(false);

    const changed = Date.now();
    writeStatus("aaa", {
      state: "done",
      message: "Intro rewritten",
      replies: [{ noteId: "n1", author: "firstmate", at: "2026-09-28T07:10:00.000Z", text: "Done, see the doc", link: null, done: true }],
    });
    const next = JSON.parse((await held.done).body);
    expect(Date.now() - changed).toBeLessThan(1000);
    expect(next.version).not.toBe(first.version);
    expect(next.statuses[0]).toMatchObject({ state: "done", replies: [{ noteId: "n1", done: true }] });
  });

  it("answers a held poll with the unchanged feed after the poll timeout", async () => {
    const { port } = await start({ pollMs: 100 });
    const first = JSON.parse((await poll(port).done).body);
    const again = JSON.parse((await poll(port, first.version).done).body);
    expect(again.version).toBe(first.version);
  });

  it("refuses folders outside the root and lets only file:// pages read the feed from page script", async () => {
    const { port } = await start();
    for (const bad of ["other/example.com/a", "firstmate-annotate/../x", "firstmate-annotate/A B", ""]) {
      expect((await fetchText(port, `/status?folder=${encodeURIComponent(bad)}`).done).status).toBe(400);
    }
    const fromFile = await fetchText(port, `/status?folder=${encodeURIComponent(FOLDER)}`, { origin: "null" }).done;
    expect(fromFile.headers["access-control-allow-origin"]).toBe("null");
    const fromSite = await fetchText(port, `/status?folder=${encodeURIComponent(FOLDER)}`, { origin: "https://evil.example" }).done;
    expect(fromSite.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a Host header that is not this server, so DNS rebinding cannot read it", async () => {
    const { port } = await start();
    const rebound = await fetchText(port, `/status?folder=${encodeURIComponent(FOLDER)}`, { host: `evil.example:${port}` }).done;
    expect(rebound.status).toBe(403);
    const local = await fetchText(port, `/status?folder=${encodeURIComponent(FOLDER)}`, { host: `localhost:${port}` }).done;
    expect(local.status).toBe(200);
  });
});

describe("presence", () => {
  it("lists a folder while a page polls it and drops it a grace period after the page goes away", async () => {
    let clock = Date.UTC(2026, 8, 28, 7, 0, 0);
    const { server, port } = await start({ now: () => clock });
    const first = JSON.parse((await poll(port, "", "tab-a").done).body);
    const held = poll(port, first.version, "tab-a");
    const other = poll(port, first.version, "tab-b");
    await until(() => server.waiting(FOLDER) === 2);

    const live = JSON.parse((await fetchText(port, "/presence").done).body);
    expect(live).toMatchObject({ format: "wm-annotate-firstmate-presence", schemaVersion: 1 });
    expect(live.folders).toEqual([{ folder: FOLDER, pages: 2, since: "2026-09-28T07:00:00.000Z", lastSeen: "2026-09-28T07:00:00.000Z" }]);

    held.abort();
    other.abort();
    await until(() => server.waiting(FOLDER) === 0);
    clock += PRESENCE_GRACE_MS - 1;
    expect(JSON.parse((await fetchText(port, "/presence").done).body).folders).toHaveLength(1);
    clock += 2;
    expect(JSON.parse((await fetchText(port, "/presence").done).body).folders).toEqual([]);
  });
});

describe("docs under the root", () => {
  it("serves a doc with its content type, and live-reloads it by its path under the root", async () => {
    const { server, port } = await start();
    const docDir = join(downloads, "firstmate-annotate", "docs", "plan");
    mkdirSync(docDir, { recursive: true });
    writeFileSync(join(docDir, "doc.html"), "<p>v1</p>");
    const reply = await fetchText(port, "/doc/docs/plan/doc.html").done;
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.body).toBe("<p>v1</p>");

    let text = "";
    const req = get(
      { host: "127.0.0.1", port, path: "/events?doc=docs%2Fplan%2Fdoc.html", headers: { origin: `http://127.0.0.1:${port}` } },
      (res) => res.on("data", (c) => (text += c))
    );
    cleanups.push(() => req.destroy());
    await until(() => server.subscribers(join(docDir, "doc.html")) === 1);
    writeFileSync(join(docDir, "doc.html"), "<p>v2</p>");
    server.notifyChange(join(docDir, "doc.html"));
    await until(() => text.includes("event: reload"));
  });

  it("serves nothing outside the root, no dotfiles, no directories", async () => {
    const { port } = await start();
    writeFileSync(join(downloads, "outside.html"), "secret");
    mkdirSync(join(downloads, "firstmate-annotate", ".hidden"), { recursive: true });
    writeFileSync(join(downloads, "firstmate-annotate", ".hidden", "x.html"), "hidden");
    for (const path of ["/doc/..%2Foutside.html", "/doc/%2E%2E/outside.html", "/doc/.hidden/x.html", "/doc/docs", "/doc/missing.html"]) {
      expect((await fetchText(port, path).done).status, path).toBe(404);
    }
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  return port;
}

describe("watcher CLI status push", () => {
  it("pushes the received status to a page polling its folder when a drop is delivered", async () => {
    const port = await freePort();
    writeFileSync(join(downloads, "firstmate-annotate.config.json"), JSON.stringify({ root: "firstmate-annotate", reloadPort: port }));
    const fm = join(downloads, "fm");
    mkdirSync(join(fm, "bin"), { recursive: true });
    writeFileSync(join(fm, "bin", "fm-inbox.sh"), "#!/bin/sh\ncat >/dev/null\necho 'queued 42-abc'\n");
    chmodSync(join(fm, "bin", "fm-inbox.sh"), 0o755);
    const child = spawn("node", [WATCHER, "--downloads", downloads, "--interval", "60000"], {
      env: { ...process.env, FM_ROOT: fm },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    cleanups.push(() => child.kill());
    await until(() => stderr.includes("watching"), 5000);

    const first = JSON.parse((await poll(port).done).body);
    expect(first.statuses).toEqual([]);
    const held = poll(port, first.version);
    await sleep(300);
    const written = Date.now();
    writeFileSync(
      join(folderDir, "firstmate-annotate-20260928T070000.000Z.json"),
      JSON.stringify({ format: "wm-annotate-firstmate", sentAt: "2026-09-28T07:00:00.000Z", page: { url: "https://example.com/a" }, notes: [{ id: "n1", body: "x" }] })
    );
    const feed = JSON.parse((await held.done).body);
    const elapsed = Date.now() - written;
    expect(feed.statuses).toMatchObject([{ state: "received", inboxId: "42-abc", noteIds: ["n1"] }]);
    // Far below the 60 s rescan, so only fs.watch can have delivered it. The real latency is logged;
    // a tighter bound fails under a loaded full-suite run.
    expect(elapsed).toBeLessThan(5000);
    console.log(`status push: page saw "received" ${elapsed}ms after the drop was written`);
  });
});
