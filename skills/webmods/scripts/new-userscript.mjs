// Scaffold a new Tampermonkey userscript: write scripts/<slug>.user.js with a
// filled metadata header, verify the target-site favicon, register it in
// greasyfork.json + the README table when those exist, and print the dev-loader
// block. Run from the repo root:
//
//   node skills/webmods/scripts/new-userscript.mjs \
//     --name "Slack Quick Edit" \
//     --match "https://app.slack.com/*" \
//     --desc "Double-click your own Slack message to edit it"
//
// Repeatable flags: --match --grant --connect --require (pass again or comma-split).
// Optional: --slug --dir --author --icon.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPEATABLE = new Set(['match', 'grant', 'connect', 'require']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let key, val;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    } else {
      key = a;
      val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
    if (REPEATABLE.has(key)) {
      const parts = typeof val === 'string' ? val.split(',').map((s) => s.trim()).filter(Boolean) : [];
      out[key] = (out[key] || []).concat(parts);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function die(msg) {
  console.error(`new-userscript: ${msg}`);
  process.exit(1);
}

function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}.${mm}.${dd}`;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function gitAuthor() {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// Host of the first http(s) @match, for the favicon guess and namespace. Returns
// null for wildcard hosts (nothing fetchable).
function hostFromMatch(match) {
  const stripped = match.replace(/^[a-z*]+:\/\//i, '');
  const host = stripped.split('/')[0];
  return host && !host.includes('*') ? host : null;
}

async function verifyFavicon(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    const type = res.headers.get('content-type') || '';
    return res.ok && type.startsWith('image/');
  } catch {
    return false;
  }
}

function metaLine(key, value) {
  return `// ${('@' + key).padEnd(13)} ${value}`;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.name || !args.desc || !args.match || args.match.length === 0) {
  console.log(
    [
      'Usage: node skills/webmods/scripts/new-userscript.mjs \\',
      '  --name "Script Name" --match "https://host/*" --desc "one line"',
      '',
      'Required: --name --match --desc',
      'Repeatable (pass again or comma-split): --match --grant --connect --require',
      'Optional: --slug --dir (default scripts) --author (default git user.name) --icon',
    ].join('\n'),
  );
  process.exit(args.help ? 0 : 1);
}

const name = String(args.name);
const desc = String(args.desc);
const slug = slugify(args.slug ? String(args.slug) : name);
if (!slug) die('could not derive a slug from --name; pass --slug');
const dir = args.dir ? String(args.dir) : 'scripts';
const author = args.author ? String(args.author) : gitAuthor() || 'You';
const grants = args.grant && args.grant.length ? args.grant : ['none'];
const connects = args.connect || [];
const requires = args.require || [];
const matches = args.match;

const cwd = process.cwd();
const relPath = join(dir, `${slug}.user.js`);
const outPath = join(cwd, relPath);
if (existsSync(outPath)) die(`${relPath} already exists - refusing to overwrite`);

// Favicon: explicit --icon wins; else guess https://<host>/favicon.ico and verify.
const host = hostFromMatch(matches[0]);
let icon = args.icon ? String(args.icon) : host ? `https://${host}/favicon.ico` : '';
const warnings = [];
if (!args.icon) {
  if (!host) {
    warnings.push(`could not derive a host from "${matches[0]}" - set @icon manually`);
  } else if (await verifyFavicon(icon)) {
    console.log(`favicon ok: ${icon}`);
  } else {
    warnings.push(`favicon ${icon} did not verify (not 200/image) - check @icon manually`);
  }
}

// Metadata header, in the repo's field order.
const header = ['// ==UserScript=='];
header.push(metaLine('name', name));
header.push(metaLine('namespace', 'http://tampermonkey.net/'));
if (icon) header.push(metaLine('icon', icon));
header.push(metaLine('version', today()));
header.push(metaLine('description', desc));
header.push(metaLine('author', author));
for (const m of matches) header.push(metaLine('match', m));
for (const g of grants) header.push(metaLine('grant', g));
for (const c of connects) header.push(metaLine('connect', c));
for (const r of requires) header.push(metaLine('require', r));
header.push(metaLine('license', 'MIT'));
header.push('// ==/UserScript==');

const body = [
  '',
  '(function () {',
  "    'use strict';",
  '',
  '    // TODO: build the feature here.',
  `    console.log('${name} loaded');`,
  '})();',
  '',
].join('\n');

if (!existsSync(join(cwd, dir))) mkdirSync(join(cwd, dir), { recursive: true });
writeFileSync(outPath, header.join('\n') + '\n' + body);
console.log(`created ${relPath}`);

// Register in greasyfork.json when present (this repo's manifest convention).
const manifestPath = join(cwd, 'greasyfork.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.scripts = manifest.scripts || [];
  if (manifest.scripts.some((s) => s.file === relPath)) {
    warnings.push(`greasyfork.json already has an entry for ${relPath} - left as is`);
  } else {
    manifest.scripts.push({ file: relPath, name, blurb: desc });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log('registered in greasyfork.json');
  }
}

// Refresh the README table when the generator is present (best-effort).
const genReadme = join(cwd, 'tools', 'gen-readme.mjs');
if (existsSync(genReadme) && existsSync(manifestPath)) {
  try {
    execFileSync('node', [genReadme], { cwd, stdio: 'inherit' });
  } catch {
    warnings.push('gen-readme failed - regenerate the README table by hand');
  }
}

// Dev-loader block: what the user pastes into Tampermonkey to live-reload the file.
const loader = ['// ==UserScript=='];
loader.push(metaLine('name', `DEV: ${name} (local)`));
loader.push(metaLine('namespace', 'http://tampermonkey.net/'));
if (icon) loader.push(metaLine('icon', icon));
loader.push(metaLine('version', '0.0.1'));
loader.push(metaLine('description', 'dev loader'));
for (const m of matches) loader.push(metaLine('match', m));
for (const g of grants) loader.push(metaLine('grant', g));
for (const c of connects) loader.push(metaLine('connect', c));
for (const r of requires) loader.push(metaLine('require', r));
loader.push(metaLine('require', `file://${outPath}`));
loader.push('// ==/UserScript==');

console.log('\n--- dev loader (paste into a new Tampermonkey script) ---');
console.log(loader.join('\n'));
console.log('--- end dev loader ---\n');

if (warnings.length) {
  console.log('warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
}
console.log(`next: open ${relPath} and build the feature (edit, reload the page, repeat).`);
