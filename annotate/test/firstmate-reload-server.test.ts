// @vitest-environment node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReloadServer } from "../bin/firstmate-reload-server.mjs";

const WATCHER = join(__dirname, "..", "bin", "firstmate-drop-watch.mjs");

let root: string;
let docDir: string;
let doc: string;
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fm-reload-"));
  docDir = join(root, "firstmate-annotate", "docs", "plan");
  mkdirSync(docDir, { recursive: true });
  doc = join(docDir, "doc.html");
  writeFileSync(doc, "<p>v1</p>");
});

afterEach(async () => {
  for (const off of cleanups.splice(0).reverse()) await off();
  rmSync(root, { recursive: true, force: true });
});

interface Stream {
  res: IncomingMessage;
  text: () => string;
  reloads: () => number;
}

function subscribe(port: number, path: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path: `/events?path=${encodeURIComponent(path)}`, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      cleanups.push(() => req.destroy());
      resolve({ res, text: () => text, reloads: () => text.split("event: reload\n").length - 1 });
    });
    req.on("error", reject);
  });
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(debounceMs = 100) {
  const server = createReloadServer({ port: 0, debounceMs, log: () => {} });
  const port = await server.listen();
  cleanups.push(() => server.close());
  return { server, port };
}

describe("reload server", () => {
  it("sends one reload per burst of writes to a watched doc, to every open copy", async () => {
    const { server, port } = await start();
    server.watchDir(join(root, "firstmate-annotate"));
    const a = await subscribe(port, doc);
    const b = await subscribe(port, doc, { origin: "null" });
    const other = await subscribe(port, join(docDir, "other.html"));
    await until(() => server.subscribers(doc) === 2);
    expect(a.res.headers["content-type"]).toBe("text/event-stream");
    expect(a.text()).toContain("retry: 1000");
    await sleep(100);

    writeFileSync(doc, "<p>v2</p>");
    writeFileSync(doc, "<p>v3</p>");
    writeFileSync(doc, "<p>v4</p>");
    await until(() => a.reloads() >= 1 && b.reloads() >= 1);
    await sleep(300);
    expect(a.reloads()).toBe(1);
    expect(b.reloads()).toBe(1);
    expect(other.reloads()).toBe(0);
    expect(a.text()).toContain('"path":');

    writeFileSync(doc, "<p>v5</p>");
    await until(() => a.reloads() === 2);
  });

  it("debounces notifyChange directly and ignores non-HTML files", async () => {
    const { server, port } = await start(50);
    const s = await subscribe(port, doc);
    await until(() => server.subscribers(doc) === 1);
    server.notifyChange(doc);
    server.notifyChange(doc);
    server.notifyChange(join(docDir, "notes.json"));
    await until(() => s.reloads() === 1);
    await sleep(150);
    expect(s.reloads()).toBe(1);
  });

  it("serves only file:// pages and local tools: other origins get 403, unknown routes 404", async () => {
    const { port } = await start();
    const evil = await subscribe(port, doc, { origin: "https://evil.example" });
    expect(evil.res.statusCode).toBe(403);
    const local = await subscribe(port, doc, { origin: "null" });
    expect(local.res.statusCode).toBe(200);
    expect(local.res.headers["access-control-allow-origin"]).toBe("null");
    const relative = await subscribe(port, "doc.html");
    expect(relative.res.statusCode).toBe(400);
    const status = await new Promise<number>((r) => get({ host: "127.0.0.1", port, path: "/" }, (res) => r(res.statusCode ?? 0)));
    expect(status).toBe(404);
  });

  it("binds to 127.0.0.1 only", async () => {
    const { server } = await start();
    expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  return port;
}

describe("watcher CLI live reload", () => {
  it("serves reload on the configured port and pushes after the doc changes", async () => {
    const port = await freePort();
    writeFileSync(join(root, "firstmate-annotate.config.json"), JSON.stringify({ root: "firstmate-annotate", reloadPort: port }));
    const fm = join(root, "fm");
    mkdirSync(join(fm, "bin"), { recursive: true });
    writeFileSync(join(fm, "bin", "fm-inbox.sh"), "#!/bin/sh\necho created\n");
    chmodSync(join(fm, "bin", "fm-inbox.sh"), 0o755);

    const child = spawn("node", [WATCHER, "--downloads", root, "--interval", "100"], {
      env: { ...process.env, FM_ROOT: fm },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    cleanups.push(() => child.kill());
    await until(() => stderr.includes(`live reload on http://127.0.0.1:${port}/events`) && stderr.includes("watching"));
    await sleep(200);

    const s = await subscribe(port, doc, { origin: "null" });
    await sleep(100);
    writeFileSync(doc, "<p>edited by the agent</p>");
    await until(() => s.reloads() === 1, 5000);
  });
});
