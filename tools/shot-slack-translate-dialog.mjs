// Captures the settings dialog straight from the REAL generated content script, so the
// screenshot can never drift from the shipped code. The dialog is self-contained; it only
// needs Slack's --sk_* theme variables, which are set here to Slack's dark values.
//
//   node tools/shot-slack-translate-dialog.mjs out.png
//
// Run from the repo root; Puppeteer is borrowed from the greasyfork skill.
import { createServer } from 'node:http';
import { writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const REPO = process.cwd();
const EXT = join(tmpdir(), 'slack-translate-shot-ext');
const OUT = process.argv[2] || join(REPO, 'extensions/slack-ai-translate/dialog.png');
const require = createRequire(join(REPO, 'skills/greasyfork/scripts/'));
const puppeteer = require('puppeteer');

rmSync(EXT, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });
copyFileSync(join(REPO, 'extensions/slack-ai-translate/gm-bridge.js'), join(EXT, 'gm-bridge.js'));
copyFileSync(join(REPO, 'extensions/slack-ai-translate/slack-ai-translate.js'), join(EXT, 'slack-ai-translate.js'));

writeFileSync(join(EXT, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'shot',
    version: '1.0',
    permissions: ['storage', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'gm-bridge.js' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['slack-ai-translate.js', 'open.js'], run_at: 'document_idle' }]
}, null, 2));

// seed the settings the screenshot should show, then open the dialog
writeFileSync(join(EXT, 'open.js'), `
(async () => {
    await chrome.storage.local.set({
        'slack-ai-translator-provider': 'ollama',
        'slack-ai-translator-local-model-host': 'http://localhost:11434',
        'slack-ai-translator-local-model-name': 'gemma4:latest'
    });
    // the script hydrates once at startup, so reload to pick the seeded values up
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); location.reload(); return; }
    const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); return fn(); };
    await until(() => document.querySelector('dialog.translate-settings-dialog'));

    // give the script the composer anchor it watches for, so it injects its own globe
    // button and the dialog opens through the real code path (which fills the prompt box)
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div class="c-texty_buttons"></div>';
    document.body.appendChild(wrapper);
    if (!await until(() => document.querySelector('.translate-input-button'))) {
        document.documentElement.setAttribute('data-dialog-open', 'FAILED: no button injected');
        return;
    }

    const button = document.querySelector('.translate-input-button');
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await until(() => document.querySelector('dialog.translate-settings-dialog').open);
    document.documentElement.setAttribute('data-dialog-open', '1');
})();
`);

const pageServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><title>shot</title>
<style>
  :root {
    --sk_primary_background: 26, 29, 33;
    --sk_primary_foreground: 209, 210, 211;
    --sk_highlight: 29, 155, 209;
  }
  html, body {
    margin: 0; height: 100%; background: rgb(26, 29, 33);
    font-family: Lato, "Helvetica Neue", Helvetica, Arial, sans-serif;
  }
  .c-texty_buttons { display: none; }
</style><body>`);
}).listen(0);

const browser = await puppeteer.launch({
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${pageServer.address().port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.hasAttribute('data-dialog-open'), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));

const dialog = await page.$('dialog.translate-settings-dialog');
const buf = await dialog.screenshot({ type: 'png' });
await browser.close();
pageServer.close();

writeFileSync(OUT, buf);
console.log(`wrote ${OUT}`);
