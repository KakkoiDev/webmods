// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultLogPath, plistPath, portBusy, renderPlist, watcherEnv } from "../bin/firstmate-drop-watch-service.mjs";

const SERVICE = join(__dirname, "..", "bin", "firstmate-drop-watch-service.mjs");
const isMac = process.platform === "darwin";

describe("renderPlist", () => {
  const plist = renderPlist({
    label: "com.example.watch",
    node: "/opt/node/bin/node",
    watcher: "/repo/annotate/bin/firstmate-drop-watch.mjs",
    env: { FM_ROOT: "/fm & co/<root>", FM_HOME: "/fm", PATH: "/usr/bin" },
    log: "/logs/watch.log",
  });

  it("restarts the watcher on any exit and starts it at login", () => {
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>3</integer>");
  });

  it("runs node on the watcher script and logs both streams to the file", () => {
    expect(plist).toContain("<string>/opt/node/bin/node</string>\n    <string>/repo/annotate/bin/firstmate-drop-watch.mjs</string>");
    expect(plist).toContain("<key>StandardOutPath</key>\n  <string>/logs/watch.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>\n  <string>/logs/watch.log</string>");
  });

  it("takes FM_ROOT and FM_HOME from the arguments, XML-escaped", () => {
    expect(plist).toContain("<key>FM_ROOT</key>\n    <string>/fm &amp; co/&lt;root&gt;</string>");
    expect(plist).toContain("<key>FM_HOME</key>\n    <string>/fm</string>");
  });
});

describe("watcherEnv", () => {
  it("passes only what was given", () => {
    expect(watcherEnv({ fmRoot: "/r", fmHome: "/h", path: "/p" })).toEqual({ FM_ROOT: "/r", FM_HOME: "/h", PATH: "/p" });
    expect(watcherEnv({ fmRoot: "/r", fmHome: "/h", path: "/p", downloads: "/d", port: 4900 })).toEqual({
      FM_ROOT: "/r",
      FM_HOME: "/h",
      PATH: "/p",
      FIRSTMATE_DOWNLOADS: "/d",
      FIRSTMATE_RELOAD_PORT: "4900",
    });
  });
});

describe("paths", () => {
  it("names the plist after the label and logs under ~/Library/Logs", () => {
    expect(plistPath("a.b", "/agents")).toBe("/agents/a.b.plist");
    expect(defaultLogPath("/home/me")).toBe("/home/me/Library/Logs/webmods/firstmate-drop-watch.log");
  });
});

describe("portBusy", () => {
  it("reports a held port and a free one", async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as { port: number }).port;
    expect(await portBusy(port)).toBe(true);
    await new Promise((r) => holder.close(r));
    expect(await portBusy(port)).toBe(false);
  });
});

describe("argument checks", () => {
  const run = (...args: string[]) => spawnSync("node", [SERVICE, ...args], { encoding: "utf8" });

  it("refuses install without FM_ROOT and FM_HOME", () => {
    const res = run("install");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--fm-root");
  });

  it("refuses an fm-root without bin/fm-inbox.sh", () => {
    const res = run("install", "--fm-root", tmpdir(), "--fm-home", tmpdir());
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("no bin/fm-inbox.sh");
  });
});

describe.skipIf(!isMac)("launchd agent", () => {
  const uid = process.getuid?.() ?? 0;
  let dir: string;
  let label: string;
  let port: number;
  const flags = () => ["--label", label, "--agents-dir", join(dir, "agents"), "--log", join(dir, "watch.log")];
  const run = (...args: string[]) => spawnSync("node", [SERVICE, ...args], { encoding: "utf8" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const printAgent = () => spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
  const pidOf = () => Number(/\bpid = (\d+)/.exec(printAgent().stdout)?.[1] ?? 0);
  async function until<T>(read: () => T, ms: number): Promise<T> {
    const end = Date.now() + ms;
    let value = read();
    while (!value && Date.now() < end) {
      await sleep(100);
      value = read();
    }
    return value;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wm-service-"));
    label = `com.kakkoidev.webmods.test-${process.pid}-${Date.now()}`;
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    mkdirSync(join(dir, "fm", "bin"), { recursive: true });
    writeFileSync(join(dir, "fm", "bin", "fm-inbox.sh"), '#!/bin/sh\ncat >/dev/null\necho "queued stub-$$"\n');
    chmodSync(join(dir, "fm", "bin", "fm-inbox.sh"), 0o755);
    mkdirSync(join(dir, "downloads"));
  });

  afterEach(() => {
    run("uninstall", ...flags());
    rmSync(dir, { recursive: true, force: true });
  });

  const install = () =>
    run("install", "--fm-root", join(dir, "fm"), "--fm-home", join(dir, "home"), "--downloads", join(dir, "downloads"), "--port", String(port), ...flags());

  it("installs, is restarted after a kill and delivers a drop file, then uninstalls cleanly", async () => {
    const res = install();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`started ${label}`);
    const first = await until(pidOf, 5000);
    expect(first).toBeGreaterThan(0);
    let listening = false;
    for (let i = 0; i < 50 && !listening; i++) {
      listening = await portBusy(port);
      if (!listening) await sleep(100);
    }
    expect(listening).toBe(true);

    process.kill(first, "SIGKILL");
    const second = await until(() => {
      const pid = pidOf();
      return pid && pid !== first ? pid : 0;
    }, 10000);
    expect(second).toBeGreaterThan(0);

    const folder = join(dir, "downloads", "firstmate-annotate", "example.com", "index");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "firstmate-annotate-1.json"),
      JSON.stringify({
        format: "wm-annotate-firstmate",
        schemaVersion: 1,
        sentAt: "2026-09-29T00:00:00.000Z",
        page: { url: "https://example.com/", title: "Example" },
        notes: [{ id: "n1", anchor: { kind: "block" }, body: "hi", createdAt: "x", updatedAt: "x" }],
      })
    );
    const processed = await until(() => existsSync(join(folder, "processed")) && readdirSync(join(folder, "processed")).length > 0, 10000);
    expect(processed).toBe(true);
    expect(readFileSync(join(dir, "watch.log"), "utf8")).toContain("sent ");

    const gone = run("uninstall", ...flags());
    expect(gone.status).toBe(0);
    expect(printAgent().status).not.toBe(0);
    expect(existsSync(join(dir, "agents", `${label}.plist`))).toBe(false);
  }, 40000);

  it("does not start a second watcher while another process holds the port", async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(port, "127.0.0.1", r));
    try {
      const res = install();
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("deferred");
      expect(printAgent().status).not.toBe(0);
      expect(existsSync(join(dir, "agents", `${label}.plist`))).toBe(true);
    } finally {
      await new Promise((r) => holder.close(r));
    }
  });

  it("installing twice leaves one agent", async () => {
    expect(install().status).toBe(0);
    const first = await until(pidOf, 5000);
    expect(first).toBeGreaterThan(0);
    const again = install();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(`started ${label}`);
    const second = await until(() => {
      const pid = pidOf();
      return pid && pid !== first ? pid : 0;
    }, 10000);
    expect(second).toBeGreaterThan(0);
    expect(spawnSync("ps", ["-p", String(first)], { encoding: "utf8" }).status).not.toBe(0);
  }, 30000);
});
