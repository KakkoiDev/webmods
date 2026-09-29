#!/usr/bin/env node
// Install or remove a per-user launchd agent that keeps firstmate-drop-watch.mjs running:
// started at login, restarted within seconds after a crash or kill.
//
// Usage: firstmate-drop-watch-service.mjs install --fm-root <path> --fm-home <path> [options]
//        firstmate-drop-watch-service.mjs uninstall [options]
//   --fm-root    firstmate checkout holding bin/fm-inbox.sh; required for install
//   --fm-home    firstmate home, passed to the watcher as FM_HOME; required for install
//   --downloads  browser download folder, passed as FIRSTMATE_DOWNLOADS; default: the watcher's own
//   --port       server port, passed as FIRSTMATE_RELOAD_PORT; default: the watcher's own
//   --label      launchd label; default com.kakkoidev.webmods.firstmate-drop-watch
//   --agents-dir where the plist goes; default ~/Library/LaunchAgents
//   --log        log file (stdout and stderr); default ~/Library/Logs/webmods/firstmate-drop-watch.log
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_LABEL = "com.kakkoidev.webmods.firstmate-drop-watch";
export const DEFAULT_PORT = 4817;
const WATCHER = join(dirname(fileURLToPath(import.meta.url)), "firstmate-drop-watch.mjs");
const RESTART_DELAY_SECONDS = 3;

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function defaultLogPath(home = homedir()) {
  return join(home, "Library", "Logs", "webmods", "firstmate-drop-watch.log");
}

export function plistPath(label, agentsDir) {
  return join(agentsDir, `${label}.plist`);
}

/** The launchd plist: KeepAlive restarts the watcher on any exit, RunAtLoad starts it at login. */
export function renderPlist({ label, node, watcher = WATCHER, env, log }) {
  const args = [node, watcher].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${RESTART_DELAY_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Environment for the agent: FM_ROOT/FM_HOME, the installer's PATH (fm-inbox.sh needs its tools), optional overrides. */
export function watcherEnv({ fmRoot, fmHome, downloads, port, path = process.env.PATH }) {
  const env = { FM_ROOT: fmRoot, FM_HOME: fmHome, PATH: path ?? "/usr/bin:/bin" };
  if (downloads) env.FIRSTMATE_DOWNLOADS = downloads;
  if (port) env.FIRSTMATE_RELOAD_PORT = String(port);
  return env;
}

/** True when something already listens on 127.0.0.1:<port>. */
export function portBusy(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", (err) => done(err.code === "EADDRINUSE"));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(false)));
  });
}

const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
const domain = () => `gui/${process.getuid()}`;

export function isLoaded(label) {
  return launchctl("print", `${domain()}/${label}`).status === 0;
}

function bootout(label) {
  if (isLoaded(label)) launchctl("bootout", `${domain()}/${label}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, label: DEFAULT_LABEL, agentsDir: join(homedir(), "Library", "LaunchAgents"), log: defaultLogPath() };
  const flags = { "--fm-root": "fmRoot", "--fm-home": "fmHome", "--downloads": "downloads", "--port": "port", "--label": "label", "--agents-dir": "agentsDir", "--log": "log" };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key) throw new Error(`unknown argument: ${rest[i]}`);
    if (rest[i + 1] === undefined) throw new Error(`${rest[i]} needs a value`);
    args[key] = rest[++i];
  }
  args.agentsDir = resolve(args.agentsDir);
  if (command !== "install" && command !== "uninstall") throw new Error("usage: install --fm-root <path> --fm-home <path> | uninstall");
  if (args.port !== undefined && !(Number(args.port) >= 1024 && Number(args.port) <= 65535)) throw new Error(`invalid port "${args.port}": use 1024-65535`);
  if (command === "install") {
    if (!args.fmRoot || !args.fmHome) throw new Error("install needs --fm-root <firstmate checkout> and --fm-home <firstmate home>");
    args.fmRoot = resolve(args.fmRoot);
    args.fmHome = resolve(args.fmHome);
    if (!existsSync(join(args.fmRoot, "bin", "fm-inbox.sh"))) throw new Error(`no bin/fm-inbox.sh under ${args.fmRoot}`);
    if (args.downloads) args.downloads = resolve(args.downloads);
    args.log = resolve(args.log);
  }
  return args;
}

/**
 * Write the plist and start the agent. The port is single-owner: when a watcher that
 * launchd does not own already holds it, the plist is written but not loaded, so no
 * second watcher fights for the port. Stop the hand-started one and install again.
 * Returns "started" or "deferred".
 */
export async function install(args, out = console.log) {
  bootout(args.label);
  const port = Number(args.port ?? DEFAULT_PORT);
  const busy = await portBusy(port);
  mkdirSync(dirname(args.log), { recursive: true });
  mkdirSync(args.agentsDir, { recursive: true });
  const path = plistPath(args.label, args.agentsDir);
  writeFileSync(
    path,
    renderPlist({ label: args.label, node: process.execPath, env: watcherEnv(args), log: args.log })
  );
  out(`wrote ${path}`);
  out(`log ${args.log}`);
  if (busy) {
    out(`deferred: 127.0.0.1:${port} is held by a watcher launchd does not own; not loading a second one.`);
    out(`hand over: stop that watcher, then run install again. It also loads at next login if the port is free.`);
    return "deferred";
  }
  const result = launchctl("bootstrap", domain(), path);
  if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${(result.stderr || "").trim()}`);
  out(`started ${args.label}`);
  return "started";
}

export function uninstall(args, out = console.log) {
  bootout(args.label);
  const path = plistPath(args.label, args.agentsDir);
  rmSync(path, { force: true });
  out(`removed ${args.label}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`firstmate-drop-watch-service: ${err.message}`);
    process.exit(2);
  }
  if (process.platform !== "darwin") {
    console.error("firstmate-drop-watch-service: launchd is macOS only");
    process.exit(2);
  }
  try {
    if (args.command === "install") await install(args);
    else uninstall(args);
  } catch (err) {
    console.error(`firstmate-drop-watch-service: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
