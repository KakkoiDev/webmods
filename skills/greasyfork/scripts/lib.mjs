// Shared helpers for the greasyfork skill. Read-only helpers use Node's built-in
// fetch (no deps). Browser helpers drive ego-browser, which is spawned only when
// one of them is called, so verify.mjs stays usable on a machine that has no
// browser tooling at all.
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GF = 'https://greasyfork.org';
// One named ego-browser task space for every browser command in this skill: an
// isolated set of tabs that inherits the user's login state. Reusing the name
// means a login done in one run is still there in the next.
export const EGO_TASK = 'greasyfork release';
export const EGO_BIN = process.env.EGO_BROWSER_BIN || 'ego-browser';

const VER = /^\s*\/\/\s*@version\s+(\S+)/m;

export function loadManifest(cwd = process.cwd()) {
  const path = join(cwd, 'greasyfork.json');
  return { path, ...JSON.parse(readFileSync(path, 'utf8')) };
}

// owner/repo/branch derived from git so nothing is hardcoded per-user.
export function repoInfo(cwd = process.cwd()) {
  const git = (cmd) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8' }).trim();
  const remote = git('remote get-url origin');
  const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse owner/repo from remote: ${remote}`);
  return { owner: m[1], repo: m[2], branch: git('rev-parse --abbrev-ref HEAD') };
}

export function rawUrl(file, info = repoInfo()) {
  return `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.branch}/${file}`;
}

export function readLocalVersion(file, cwd = process.cwd()) {
  return readFileSync(join(cwd, file), 'utf8').match(VER)?.[1] ?? null;
}

export async function fetchPublished(id, locale = 'en') {
  const r = await fetch(`https://api.greasyfork.org/${locale}/scripts/${id}.json`);
  if (!r.ok) throw new Error(`API ${id}: HTTP ${r.status}`);
  const j = await r.json();
  return { version: j.version, name: j.name, codeUrl: j.code_url };
}

export async function fetchRawVersion(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`raw HTTP ${r.status}`);
  return (await r.text()).match(VER)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// ego-browser
//
// ego-browser exposes no importable Browser/Page object: browser work is
// JavaScript handed to `ego-browser nodejs` on stdin, which runs it inside the
// browser's own Node runtime. So a "browser step" here is a source string, not a
// call chain, and a command is a short sequence of such steps.
//
// That runtime is not a child of this process - it does not inherit our env, our
// cwd or our argv - so everything a step needs is serialized into the script as
// INPUT, and everything it produces comes back through emit(). Its output is
// also buffered until it exits, which is why anything the user must read while a
// step is still running (the login prompt) is printed here, between steps.
// ---------------------------------------------------------------------------
const RESULT = '@@ego-result@@';

const PREAMBLE = `
const GF = ${JSON.stringify(GF)};
const INPUT = __EGO_INPUT__;
const emit = (v) => cliLog(${JSON.stringify(RESULT)} + JSON.stringify(v === undefined ? null : v));
const task = await useOrCreateTaskSpace(${JSON.stringify(EGO_TASK)});

// waitForLoad() reports on the CURRENT document, so right after a click it
// answers "yes, loaded" about the page being navigated away from. A change of
// URL is the only barrier that means the submission actually went somewhere.
async function submitAndWait(selector, label) {
  const before = (await pageInfo()).url;
  await click(selector, { label });
  for (let i = 0; i < 90; i++) {
    await wait(1);
    if ((await pageInfo()).url !== before) break;
  }
  await waitForLoad({ timeout: 60 }).catch(() => {});
  return (await pageInfo()).url;
}
`;

// Run one browser step. `body` is JavaScript for ego-browser's runtime, where it
// can use INPUT, emit(), GF, task and submitAndWait(). Resolves to whatever the
// body emit()ed. `close` ends the task space afterwards - pass false for a step
// that another step continues from, true (the default) for a command's last one.
export function ego(body, input = null, { close = true } = {}) {
  const script = PREAMBLE.replace('__EGO_INPUT__', () => JSON.stringify(input))
    + `\nconst __step = async () => {\n${body}\n};\n`
    + (close
      ? `try { await __step(); } finally { await completeTaskSpace(task.id, { keep: false }).catch(() => {}); }\n`
      : `await __step();\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(EGO_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', (e) => reject(new Error(
      e.code === 'ENOENT'
        ? `${EGO_BIN} not found on PATH. The browser commands need ego-browser (ego lite);`
          + ` install it, or set EGO_BROWSER_BIN. verify.mjs needs none of this.`
        : `${EGO_BIN} failed to start: ${e.message}`,
    )));

    let result, found = false, err = '';
    // cliLog writes to the child's stderr, and the runtime's own warnings land
    // there too, so both streams are scanned for the marker and whatever is left
    // is kept as diagnostics - reported only if the step fails.
    const take = (line) => {
      if (line.startsWith(RESULT)) { result = JSON.parse(line.slice(RESULT.length)); found = true; }
      else if (line.trim()) err += line + '\n';
    };
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        lines.forEach(take);
      });
      stream.on('end', () => { if (pending) take(pending); });
    }
    child.on('close', (code) => {
      if (code === 0 && found) return resolve(result);
      reject(new Error(`ego-browser step failed (exit ${code}${found ? '' : ', no result'}):\n${err.trim()}`));
    });
    child.stdin.end(script);
  });
}

// Greasy Fork has no API auth. We reuse the browser's own session: the user logs
// in once in the visible window and every later run finds it still there (task
// spaces share the browser's cookie jar, so the session outlives the space).
// The check must run in-browser (user's IP) because of Cloudflare; a Node-side
// fetch from elsewhere would be blocked.
//
// Logged out, Greasy Fork redirects webhook-info to its sign-in page, so one
// navigation both tests the session and parks the user where they log in. The
// poll that follows is a same-origin browserFetch issued from that very page,
// never a navigation, so the login tab is never reloaded mid-input.
const IS_LOGGED_IN = `
  await openOrReuseTab(GF + '/en/users/webhook-info', { wait: true, timeout: 60 });
  emit(String(await js(String.raw\`document.body.innerText\`)).includes('Setting up a webhook'));
`;

const AWAIT_LOGIN = `
  let last = '';
  for (let i = 0; i < 75; i++) {
    await wait(7);
    try {
      if (String(await browserFetch(GF + '/en/users/webhook-info')).includes('Setting up a webhook')) {
        emit(true);
        return;
      }
      last = '';
    } catch (e) {
      last = e.message;
    }
  }
  emit(last || false);
`;

export async function ensureLoggedIn() {
  if (await ego(IS_LOGGED_IN, null, { close: false })) return true;
  console.error('\n>>> Log in to Greasy Fork in the ego-browser window that just opened. Detecting automatically; your tab is not reloaded.\n');
  const r = await ego(AWAIT_LOGIN, null, { close: false });
  if (r !== true) {
    throw new Error(`Still not logged in after ~9 min.${typeof r === 'string' ? ` Last browser error: ${r}` : ''}`);
  }
  console.error('>>> Login detected. Continuing.\n');
  return true;
}

// Set published scripts to sync-from-URL (Automatic) and trigger an immediate
// pull, by driving their Greasy Fork Admin pages. Used by release.mjs. Returns
// one { url, ok, message } per target, in order. The form selectors live here so
// there's one place to fix them.
export async function syncScripts(targets, info = repoInfo()) {
  await ensureLoggedIn();
  const input = targets.map((s) => ({ id: s.id, url: rawUrl(s.file, info) }));
  return ego(`
    const out = [];
    for (const t of INPUT) {
      await gotoAndWait(GF + '/en/scripts/' + t.id + '/admin', { timeout: 60 });
      const present = await js(String.raw\`!!document.querySelector('#script_sync_identifier')\`);
      if (!present) {
        out.push({ url: t.url, ok: false, message: '#script_sync_identifier not found (not your script / layout changed)' });
        continue;
      }
      await js('(() => { const el = document.querySelector("#script_sync_identifier");'
        + ' el.value = ' + JSON.stringify(t.url) + ';'
        + ' el.dispatchEvent(new Event("input", { bubbles: true })); })()');
      await js(String.raw\`(() => { const el = document.querySelector('#script_sync_type_automatic');
        el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()\`);
      await js(String.raw\`document.querySelector('input[name="update-and-sync"]').scrollIntoView({ block: 'center' })\`);
      await submitAndWait('input[name="update-and-sync"]', 'update and sync script');
      const message = await js(String.raw\`(() => {
        const g = (sel) => document.querySelector(sel)?.innerText?.trim();
        return g('.flash') || g('.notice') || g('.alert') || g('[role=alert]') || '(no flash message)';
      })()\`);
      out.push({ url: t.url, ok: true, message });
    }
    emit(out);
  `, input);
}
