#!/usr/bin/env node
// Compose a Chrome Web Store screenshot (1280x800 or 640x400) by placing one or two
// captured PNGs on a branded canvas with a caption, instead of upscaling a small capture
// to fill the frame. pad-screenshot.mjs letterboxes; this one keeps the UI near its
// native size so text stays crisp, which matters because most captures are far smaller
// than the store's required dimensions.
//
//   node frame-screenshot.mjs out.png --caption="…" --shot=a.png [--shot=b.png]
//                                     [--scale=1.2] [--size=1280x800] [--bg=4A154B]
//
// Two --shot arguments are laid out side by side, for a before/after pair.
// Puppeteer is borrowed from the greasyfork skill rather than added as a dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const shots = args.filter((a) => a.startsWith('--shot=')).map((a) => a.slice(7));

if (!out || !shots.length) {
    console.error('usage: frame-screenshot.mjs out.png --shot=a.png [--shot=b.png] [--caption=…] [--scale=1] [--size=1280x800] [--bg=4A154B]');
    process.exit(1);
}

const [width, height] = flag('size', '1280x800').split('x').map(Number);
const scale = Number(flag('scale', '1'));
const bg = flag('bg', '4A154B').replace(/^#/, '');
const caption = flag('caption', '');

const dataUri = (p) => {
    const ext = extname(p).slice(1).toLowerCase();
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${readFileSync(p).toString('base64')}`;
};

const require = createRequire(resolve('skills/greasyfork/scripts/') + '/');
const puppeteer = require('puppeteer');

const html = `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px; height: ${height}px; overflow: hidden;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: ${Math.round(height * 0.05)}px;
    background: radial-gradient(circle at 50% 0%, #${bg} 0%, #2a0c2b 100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 {
    color: #fff; font-size: ${Math.round(height * 0.042)}px; font-weight: 700;
    letter-spacing: -0.01em; text-align: center; max-width: 85%;
  }
  .row { display: flex; align-items: center; justify-content: center; gap: ${Math.round(width * 0.03)}px; }
  img {
    display: block; border-radius: 10px;
    box-shadow: 0 18px 50px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08);
  }
</style>
${caption ? `<h1>${caption.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h1>` : ''}
<div class="row">
  ${shots.map((s) => `<img src="${dataUri(s)}" style="width:${Math.round(0)}">`).join('')}
</div>
<script>
  for (const img of document.images) {
    img.addEventListener('load', () => {
      img.style.width = Math.round(img.naturalWidth * ${scale}) + 'px';
    });
  }
</script>`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
const buf = await page.screenshot({ type: 'png' });
await browser.close();

writeFileSync(out, buf);
console.log(`wrote ${out} (${width}x${height}, ${shots.length} shot${shots.length > 1 ? 's' : ''} at ${scale}x)`);
