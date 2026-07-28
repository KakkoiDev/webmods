// Captures the store screenshot pair straight from the REAL generated content script, so the
// shot can never drift from the shipped code - and, more importantly, so no real DM list is
// published: the rows below are invented names, which is the point of an extension that exists
// to hide them.
//
//   node tools/shot-slack-dm-blur.mjs [outDir]     (default /tmp; writes dm-blur-off.png, dm-blur-on.png)
//
// Run from the repo root; Puppeteer is borrowed from the greasyfork skill.
import { createServer } from 'node:http';
import { writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const REPO = process.cwd();
const EXT = join(tmpdir(), 'slack-dm-blur-shot-ext');
const OUT_DIR = process.argv[2] || '/tmp';
const require = createRequire(join(REPO, 'skills/greasyfork/scripts/'));
const puppeteer = require('puppeteer');

rmSync(EXT, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });
copyFileSync(join(REPO, 'extensions/slack-dm-blur/slack-dm-blur.js'), join(EXT, 'slack-dm-blur.js'));
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'shot',
    version: '1.0',
    minimum_chrome_version: '111',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['slack-dm-blur.js'], run_at: 'document_start', world: 'MAIN' }]
}, null, 2));

// Invented people, invented previews. Never capture a real DM list for a public listing.
const DMS = [
    ['AL', '#e8912d', 'Ada Lovelace', 'can you look at the analytics engine spec', '9:41'],
    ['GH', '#2eb886', 'Grace Hopper', 'nanoseconds attached', '9:12'],
    ['KJ', '#e01e5a', 'Katherine Johnson', 'numbers check out, ship it', 'Yesterday'],
    ['AT', '#1264a3', 'Alan Turing', 'you: rescheduling to Thursday', 'Yesterday'],
    ['MH', '#8d4bbb', 'Margaret Hamilton', 'priority display added to the checklist', 'Monday'],
    ['DE', '#007a5a', 'Dorothy Vaughan', 'you: thanks for the review', 'Monday']
];

const rows = DMS.map(([initials, color, name, preview, when]) => `
  <div class="dm" data-qa="dms_channel">
    <div class="avatar" style="background:${color}">${initials}</div>
    <div class="text"><div class="name">${name}</div><div class="preview">${preview}</div></div>
    <div class="when">${when}</div>
  </div>`).join('');

const pageServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><title>shot</title>
<style>
  :root { --sk_primary_background: 26,29,33; --sk_primary_foreground: 209,210,211; }
  html, body { margin: 0; background: rgb(26,29,33); font-family: Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  #panel { width: 420px; padding: 14px 0 10px; background: rgb(26,29,33); color: rgb(209,210,211); }
  .head { display: flex; align-items: center; gap: 14px; padding: 0 16px 12px; }
  .title { font-size: 18px; font-weight: 900; color: #fff; flex: 1; }
  .p-unreads_toggle { display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 0;
      color: rgb(171,171,173); font: inherit; font-size: 13px; cursor: pointer; }
  .p-unreads_toggle__switch { width: 30px; height: 16px; border-radius: 9px; background: rgba(209,210,211,.3); position: relative; }
  .p-unreads_toggle--selected .p-unreads_toggle__switch { background: #007a5a; }
  .p-unreads_toggle__switch__handle { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
      border-radius: 50%; background: #fff; transition: left .1s; }
  .p-unreads_toggle--selected .p-unreads_toggle__switch__handle { left: 16px; }
  .dm { display: flex; align-items: center; gap: 10px; padding: 7px 16px; }
  .avatar { width: 36px; height: 36px; border-radius: 4px; flex: none; color: #fff;
      font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .text { flex: 1; min-width: 0; }
  .name { font-size: 15px; font-weight: 700; color: #fff; }
  .preview { font-size: 13px; color: rgb(171,171,173); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when { font-size: 12px; color: rgb(171,171,173); flex: none; }
</style>
<body><div id="panel">
  <div class="head">
    <div class="title">Direct messages</div>
    <button class="c-button-unstyled p-unreads_toggle" data-qa="dms-unreads-toggle-button" type="button">
      <div class="p-unreads_toggle__label">Unreads</div>
      <div class="p-unreads_toggle__switch"><div class="p-unreads_toggle__switch__handle"></div></div>
    </button>
  </div>${rows}
</div></body>`);
}).listen(0);

const browser = await puppeteer.launch({
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width: 520, height: 460, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${pageServer.address().port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('[data-qa="tms-dm-blur-toggle-button"]'), { timeout: 30000 });

const panel = await page.$('#panel');
const shoot = async (name) => {
    await new Promise((r) => setTimeout(r, 250));
    const out = join(OUT_DIR, name);
    writeFileSync(out, await panel.screenshot({ type: 'png' }));
    console.log('wrote', out);
};

// the toggle's own click handler drives both states, so the shots show the real code path
await page.evaluate(() => { if (document.documentElement.classList.contains('tms-dm-blur-on')) document.querySelector('[data-qa="tms-dm-blur-toggle-button"]').click(); });
await shoot('dm-blur-off.png');
await page.click('[data-qa="tms-dm-blur-toggle-button"]');
await shoot('dm-blur-on.png');

await browser.close();
pageServer.close();
