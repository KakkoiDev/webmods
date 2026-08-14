// Publish a NEW userscript to Greasy Fork (the most consequential write: it
// creates a public/unlisted listing). Pastes the local file's code, sets
// visibility from the manifest, submits, captures the new id, and writes it
// back to greasyfork.json. Requires login (ego-browser task space).
//
// usage: node register.mjs <file.user.js>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, ego, ensureLoggedIn } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node register.mjs <file.user.js>');
  process.exit(1);
}
const manifest = loadManifest();
const entry = manifest.scripts.find((s) => s.file === file);
if (!entry) {
  console.error(`No manifest entry for "${file}" in greasyfork.json.`);
  process.exit(1);
}
if (entry.id) {
  console.error(`"${file}" already has id ${entry.id}. Refusing to create a duplicate.`);
  process.exit(1);
}
const code = readFileSync(join(process.cwd(), file), 'utf8');
const typeValue = entry.visibility === 'unlisted' ? '2' : entry.visibility === 'library' ? '3' : '1';
console.log(`Registering ${file} as ${entry.visibility} (script_type=${typeValue})`);

await ensureLoggedIn();
const r = await ego(`
  await gotoAndWait(GF + '/en/script_versions/new', { timeout: 60 });

  // Code field is a plain textarea unless the syntax editor is opted into (it isn't).
  await js('(() => { const el = document.querySelector("#script_version_code");'
    + ' el.value = ' + JSON.stringify(INPUT.code) + ';'
    + ' el.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await js('(() => { const el = document.querySelector("#script_script_type_' + INPUT.typeValue + '");'
    + ' el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); })()');

  const url = await submitAndWait('input[name="commit"]', 'submit new script');
  if (/\\/scripts\\/(\\d+)/.test(url)) {
    emit({ url, id: url.match(/\\/scripts\\/(\\d+)/)[1] });
  } else {
    emit({ url, id: null, page: await js(String.raw\`(() => {
      const e = document.querySelector('#error_explanation, .alert, .errorlist, .form-error');
      return (e?.innerText || document.body.innerText).slice(0, 1000);
    })()\`) });
  }
`, { code, typeValue });

if (!r.id) {
  console.error(`Did NOT land on a script page. URL=${r.url}\n--- page said ---\n${r.page}`);
  process.exit(2);
}

console.log(`OK: ${file} -> script id ${r.id}\n     ${r.url}`);

entry.id = r.id; // entry is a reference into manifest.scripts
const { path, ...data } = manifest; // path is injected by loadManifest; don't write it
writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
console.log(`Wrote id ${r.id} into ${path}`);
