import { build } from "esbuild";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
mkdirSync(join(root, "dist"), { recursive: true });

const banner = `/* @webmods/annotate v${pkg.version} | MIT | https://github.com/KakkoiDev/webmods */`;

const common = {
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  target: "es2020",
  banner: { js: banner },
  logLevel: "info",
};

// Browser/global build (unminified + minified)
await build({
  ...common,
  format: "iife",
  globalName: "WebmodsAnnotate",
  outfile: join(root, "dist/annotate.js"),
});
await build({
  ...common,
  format: "iife",
  globalName: "WebmodsAnnotate",
  minify: true,
  outfile: join(root, "dist/annotate.min.js"),
});

// ESM build
await build({
  ...common,
  format: "esm",
  outfile: join(root, "dist/annotate.esm.js"),
});

// Reference userscript: library + thin Tampermonkey host, single file.
const result = await build({
  entryPoints: [join(root, "src/userscript-main.ts")],
  bundle: true,
  target: "es2020",
  format: "iife",
  write: false,
  logLevel: "info",
});

const today = new Date();
const version = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;

// Inline data: URI icon (pencil on indigo) — the script targets every site, so
// there is no single target-site favicon; data: always renders in the dashboard.
const icon =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#6366f1"/><text x="32" y="42" font-size="32" text-anchor="middle">✏️</text></svg>`
  ).toString("base64");

const header = `// ==UserScript==
// @name         Webmods Annotate
// @namespace    http://tampermonkey.net/
// @icon         ${icon}
// @version      ${version}
// @description  Annotate any web page with Markdown notes - robust anchors, cross-site Tampermonkey storage, notes sidebar, shareable note links, JSON export/import (Alt+Shift+A)
// @author       KakkoiDev
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @license      MIT
// ==/UserScript==

`;

const userscript = header + result.outputFiles[0].text;
writeFileSync(join(root, "dist/annotate.user.js"), userscript);

// Copy the reference userscript into the repo's scripts/ dir (repo convention).
copyFileSync(join(root, "dist/annotate.user.js"), join(root, "..", "scripts", "webmods-annotate.user.js"));

console.log("Built dist/annotate.{js,min.js,esm.js,user.js} and scripts/webmods-annotate.user.js");
