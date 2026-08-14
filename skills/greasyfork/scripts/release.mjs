// The single Greasy Fork update mechanism. Greasy Fork's per-user webhook
// endpoint returns 403 to every POST (server-side at GF - see
// docs/PUBLISHING.md), so pushes never auto-pull. This forces the pull.
//
// Two modes:
//   node .../release.mjs                 # after a push: sync every script whose
//                                        #   published version is behind, verify
//   node .../release.mjs --push          # push first, then the above
//   node .../release.mjs <id|file|all>   # wire/re-point sync-from-URL + Automatic
//                                        #   for those scripts and pull now, verify
//                                        #   (use for a new script's first sync, or
//                                        #    after moving/renaming a file)
//
// Requires login (ego-browser task space). The read/drift steps need none.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  loadManifest, repoInfo, rawUrl, fetchPublished, fetchRawVersion, readLocalVersion,
  syncScripts,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const doPush = argv.includes('--push');
const sel = argv.filter((a) => a !== '--push'); // ids / files / "all"

const { scripts, locale = 'en' } = loadManifest();
const info = repoInfo();

if (doPush) {
  console.log('git push...');
  execSync('git push', { stdio: 'inherit' });
}

function runVerify() {
  console.log('\nverifying...');
  try {
    execSync(`node ${join(here, 'verify.mjs')}`, { stdio: 'inherit' });
  } catch {
    console.error('\nStill drifting after sync - re-run, or check the sync output above.');
    process.exit(1);
  }
}

// One browser session drives every target, so the results arrive together and
// are printed here rather than as each one lands.
async function syncTargets(targets) {
  const results = await syncScripts(targets, info);
  results.forEach((r, i) => {
    const s = targets[i];
    console.log(`\n[${s.id}] ${s.file} -> ${r.url}`);
    console.log(`  ${r.ok ? 'result: ' + r.message : '!! ' + r.message}`);
  });
}

// Explicit-target mode: wire/re-point sync-from-URL + pull the named scripts.
// Used for a new script's first sync or after a move/rename.
if (sel.length) {
  const want = (s) => s.id && (sel.includes('all') || sel.includes(String(s.id)) || sel.includes(s.file));
  const targets = scripts.filter(want);
  if (!targets.length) {
    console.error('No matching published scripts in greasyfork.json.');
    process.exit(1);
  }
  await syncTargets(targets);
  runVerify();
} else {
  // Default mode: sync only scripts whose published version is behind the local file.
  async function findDrift() {
    const out = [];
    for (const s of scripts) {
      if (!s.id) continue;
      const local = readLocalVersion(s.file);
      let raw = null, published = null;
      try { raw = await fetchRawVersion(rawUrl(s.file, info)); } catch { /* CDN not ready */ }
      try { published = (await fetchPublished(s.id, locale)).version; } catch { /* ignore */ }
      if (published !== local) out.push({ s, local, raw });
    }
    return out;
  }

  let pending = await findDrift();
  if (!pending.length) {
    console.log('All published scripts already in sync. Nothing to do.');
    process.exit(0);
  }
  console.log(`Out of sync: ${pending.map((p) => p.s.file).join(', ')}`);

  // Greasy Fork pulls the raw GitHub URL, so raw must already serve the local
  // version - otherwise the sync re-pulls a stale file. Wait for the CDN.
  for (let i = 0; i < 10; i++) {
    const stale = pending.filter((p) => p.raw !== p.local);
    if (!stale.length) break;
    console.log(`waiting ~30s for raw CDN to catch up: ${stale.map((p) => p.s.file).join(', ')}`);
    await sleep(30000);
    pending = await findDrift();
  }

  await syncTargets(pending.map((p) => p.s));
  runVerify();
}
