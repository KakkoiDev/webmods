// Drives the Chrome Web Store Developer Dashboard in a real browser, for the parts the
// CWS API cannot do: creating the item, the store-listing copy, screenshots, and the
// privacy answers. Same shape as the greasyfork skill's release.mjs - headful Chrome on a
// persisted profile, you sign in once by hand, later runs reuse the session.
//
// First, in a terminal, launch a normal Chrome and sign in by hand (see SKILL.md):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 \
//     --user-data-dir="$HOME/.cache/chrome-web-store/chrome-profile" &
//
// Then:
//   node skills/chrome-web-store/scripts/dashboard.mjs all          # every step, unattended
//   node skills/chrome-web-store/scripts/dashboard.mjs listing      # or one step at a time:
//                          # newitem | upload | listing | save | privacy | distribution
//   node ... listing shots  # and `listing` takes text|icon|shots to redo just one part
//
// `all` CREATES A NEW ITEM every time - use the individual steps to edit an existing one.
//
// It deliberately never ticks the developer certification checkboxes and never presses
// Submit: those are your legal attestation, not the script's.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const PROFILE_DIR = join(homedir(), '.cache', 'chrome-web-store', 'profile');
export const DEVCONSOLE = 'https://chrome.google.com/webstore/devconsole';
const OUT = join(homedir(), '.cache', 'chrome-web-store', 'recon');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(resolve('skills/greasyfork/scripts/') + '/');

export async function launchBrowser() {
    const puppeteer = require('puppeteer');
    mkdirSync(PROFILE_DIR, { recursive: true });
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: PROFILE_DIR,
        defaultViewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    return { browser, page };
}

// The dashboard is a single-page app behind a Google sign-in. Detection just checks
// whether the devconsole renders its item table instead of bouncing to accounts.google.com.
export async function ensureLoggedIn(page) {
    const onDashboard = async () => {
        await page.goto(DEVCONSOLE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(2500);
        return !page.url().includes('accounts.google.com');
    };
    if (await onDashboard()) return true;
    console.error('\n>>> Sign in to Google in the browser window that just opened.');
    console.error('>>> Detecting automatically. Do not close the window.\n');
    for (let i = 0; i < 90; i++) {
        await sleep(8000);
        const url = page.url();
        // logged every poll: a silent timeout tells us nothing about WHERE it stalled
        console.error(`   [${i}] ${url.slice(0, 110)}`);
        if (url.includes('rejected') || url.includes('deniedsigninrejected')) {
            console.error('\n>>> Google refused sign-in in this automated browser.');
            console.error('>>> Fallback: attach to your everyday Chrome instead (see --attach).\n');
            return false;
        }
        if (!url.includes('accounts.google.com')) {
            await sleep(3000);
            if (await onDashboard()) {
                console.error('>>> Signed in. Continuing.\n');
                return true;
            }
        }
    }
    console.error('\n>>> Not signed in after ~12 min. Leaving the window open.\n');
    return false;
}

// The dashboard is Angular Material with heavy shadow DOM, so selectors have to be found
// against the live page rather than guessed. This walks every shadow root and reports the
// interactive elements with whatever stable handle they carry.
export async function recon(page, label) {
    mkdirSync(OUT, { recursive: true });
    const shot = join(OUT, `${label}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    const controls = await page.evaluate(() => {
        const found = [];
        const walk = (root) => {
            for (const el of root.querySelectorAll('*')) {
                const tag = el.tagName.toLowerCase();
                const interactive = /^(button|input|textarea|select|a)$/.test(tag)
                    || el.getAttribute('role') === 'button'
                    || el.hasAttribute('contenteditable');
                if (interactive) {
                    const text = (el.innerText || el.value || '').trim().slice(0, 60);
                    found.push({
                        tag,
                        type: el.getAttribute('type'),
                        name: el.getAttribute('name'),
                        aria: el.getAttribute('aria-label'),
                        id: el.id || null,
                        text: text || null,
                        visible: !!(el.offsetWidth || el.offsetHeight),
                    });
                }
                if (el.shadowRoot) walk(el.shadowRoot);
            }
        };
        walk(document);
        return found.filter((c) => c.visible && (c.text || c.aria || c.name || c.id));
    });

    const dump = join(OUT, `${label}.json`);
    writeFileSync(dump, JSON.stringify({ url: page.url(), title: await page.title(), controls }, null, 2));
    console.error(`recon: ${shot}`);
    console.error(`recon: ${dump} (${controls.length} controls)`);
    return { shot, dump, controls };
}

// Select a Material radio. Clicking the label TEXT looks like it works and silently does
// nothing - the real input[type=radio] is a 32x32 element found by walking up to the text.
// Returns the checked state afterwards so callers can verify instead of assuming.
export async function pickRadio(page, labelPrefix) {
    const box = await page.evaluate((labelPrefix) => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const radio = all.filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => {
            let n = e, txt = '';
            for (let i = 0; i < 5 && n && !txt; i++, n = n.parentElement) txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
            return txt.startsWith(labelPrefix);
        });
        if (!radio) return null;
        radio.scrollIntoView({ block: 'center' });
        const r = radio.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, labelPrefix);
    if (!box) throw new Error(`radio "${labelPrefix}" not found`);
    await sleep(500);
    await page.mouse.click(box.x, box.y);
    await sleep(1500);
    const checked = await page.evaluate((labelPrefix) => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const radio = all.filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => {
            let n = e, txt = '';
            for (let i = 0; i < 5 && n && !txt; i++, n = n.parentElement) txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
            return txt.startsWith(labelPrefix);
        });
        return !!radio?.checked;
    }, labelPrefix);
    if (!checked) throw new Error(`radio "${labelPrefix}" did not take`);
    return checked;
}

// Google refuses its sign-in flow inside a Puppeteer-launched Chrome ("This browser or app
// may not be secure"). So we never sign in under automation: the user launches a normal
// Chrome with a debugging port on a dedicated profile, signs in there, and we attach to the
// already-authenticated session. Chrome blocks --remote-debugging-port on the DEFAULT
// profile, hence the separate --user-data-dir.
export async function attach() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null,
        protocolTimeout: 240000,
    });
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes('chrome.google.com') || p.url().includes('accounts.google.com'))
        ?? pages[0] ?? (await browser.newPage());
    // A native dialog blocks the renderer, and every later CDP call - even attaching -
    // times out with no hint as to why. The dashboard raises a beforeunload prompt on any
    // navigation with unsaved edits, so without this an unattended run wedges permanently.
    page.on('dialog', async (d) => {
        console.error(`dismissing ${d.type()} dialog: ${d.message().slice(0, 60)}`);
        await d.accept().catch(() => {});
    });
    return { browser, page };
}

// Run every dashboard step end to end, in one attached session. Each `sub` is the same
// code the individual steps run; keeping one browser connection avoids re-attaching
// between phases, which is where stale CDP sessions used to pile up.
async function runAll() {
    const steps = ['newitem', 'upload', 'listing', 'save', 'privacy', 'save', 'distribution', 'save'];
    for (const s of steps) {
        console.error(`\n=== ${s} ===`);
        execSync(`node ${process.argv[1]} ${s}`, { stdio: 'inherit' });
    }
    console.error('\nAll steps done. The item is a saved Draft.');
    console.error('Left for you: the three certification checkboxes and Submit for review.');
}

// Only act as a CLI when run directly. Importing this module (to reuse pickRadio, attach,
// ...) must never launch a browser - it once did, and spawned a second Chrome that tripped
// Google's automation block.
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const step = isCli ? (process.argv[2] || 'login') : null;
if (!isCli) {
    // imported as a library: stop before the dispatch below
} else

if (step === 'login') {
    const { page } = await launchBrowser();
    const ok = await ensureLoggedIn(page);
    // recon whatever is on screen either way - a block page is the diagnosis we need
    await recon(page, ok ? 'devconsole' : 'stuck');
    console.error(ok
        ? '\nSigned in and on the dashboard. Leave this window open for the next step.\n'
        : '\nNot on the dashboard. Window left open; see the recon screenshot above.\n');
    // deliberately never closing the browser: the next step reuses this window,
    // and on failure the page state is the evidence
} else if (step === 'newitem') {
    const { browser, page } = await attach();
    // networkidle2 never fires on this SPA - it keeps connections open indefinitely.
    // Wait for the control we need instead of for the network to go quiet.
    await page.goto(DEVCONSOLE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // `>>>` pierces shadow roots; the dashboard is Angular Material so a plain
    // querySelector never reaches these controls
    const add = await page.waitForSelector('>>> button[aria-label="Add a new item"]', { timeout: 60000 });
    console.error('found New item button, clicking');
    await add.click();
    await sleep(4000);
    await recon(page, 'newitem-dialog');
    await browser.disconnect();
} else if (step === 'upload') {
    const zip = resolve(process.argv[3] || 'extensions/slack-ai-translate-cws.zip');
    const { browser, page } = await attach();
    // the Add-new-item dialog must already be open (run the `newitem` step first)
    const input = await page.waitForSelector('>>> input[type=file]', { timeout: 30000 });
    console.error(`uploading ${zip}`);
    await input.uploadFile(zip);
    await sleep(8000);
    await recon(page, 'after-upload');
    console.error(`url now: ${page.url()}`);
    await browser.disconnect();
} else if (step === 'listing') {
    const { readFileSync } = await import('node:fs');
    const md = readFileSync(resolve('extensions/slack-ai-translate/store-listing.md'), 'utf8');
    const blocks = [...md.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    const description = blocks[1];
    if (!description || description.length < 500) throw new Error('description block looks wrong');

    const { browser, page } = await attach();
    // a dropdown left open by a previous run swallows the next click
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);

    // Auto-generated ids (c11, c31...) shift between renders, so every control is found by
    // its label and then tagged, and the tag is what Puppeteer clicks - real mouse events,
    // because Angular Material ignores synthetic ones in places.
    const tagByLabel = (label, tag, opts = {}) => page.evaluate((label, tag, opts) => {
        const all = [];
        const walk = (r) => {
            for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
        };
        walk(document);
        // same resolution order the recon dump uses: aria-labelledby, aria-label, then the
        // nearest <label> up the tree - the Description textarea only has the last of those
        const labelOf = (el) => {
            const by = el.getAttribute('aria-labelledby');
            if (by) {
                const t = by.split(/\s+/).map((i) => document.getElementById(i)?.innerText?.trim()).filter(Boolean).join(' ');
                if (t) return t;
            }
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
            let n = el.parentElement;
            for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
                const lab = n.querySelector('label, .label, [class*=label]');
                if (lab?.innerText?.trim()) return lab.innerText.trim();
            }
            return '';
        };
        const match = all.find((el) => {
            if (!(el.offsetWidth || el.offsetHeight)) return false;
            if (opts.role && el.getAttribute('role') !== opts.role) return false;
            if (opts.tag && el.tagName.toLowerCase() !== opts.tag) return false;
            return labelOf(el).startsWith(label);
        });
        if (!match) return false;
        if (opts.file) {
            // the drop-zone button and its hidden input live in the same component
            let n = match, input = null;
            for (let i = 0; i < 6 && n && !input; i++, n = n.parentElement) input = n.querySelector?.('input[type=file]');
            if (!input) return false;
            input.dataset.cws = tag;
            return true;
        }
        match.dataset.cws = tag;
        return true;
    }, label, tag, opts);

    // ElementHandle operations on a `>>>`-pierced shadow element are unreliable here - they
    // either throw "not clickable" or hang the CDP call. Compute the rect in-page and click
    // the coordinates with the real mouse instead.
    const clickTag = async (tag) => {
        const box = await page.evaluate((tag) => {
            const all = [];
            const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
            walk(document);
            const el = all.find((e) => e.dataset?.cws === tag);
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }, tag);
        if (!box) throw new Error(`cannot click "${tag}" - not found or zero-sized`);
        await sleep(400);
        await page.mouse.click(box.x, box.y);
        await sleep(1000);
    };

    const pickOption = async (text) => {
        await sleep(1200);
        const ok = await page.evaluate((text) => {
            // clear tags from an earlier run, or waitForSelector matches a stale option
            document.querySelectorAll('[data-cws="option"]').forEach((e) => delete e.dataset.cws);
            const all = [];
            const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
            walk(document);
            // options exist in the DOM even when the menu is shut - a closed menu's options
            // are 0x0, so size is what distinguishes "open" from "present"
            const opt = all.find((el) => el.getAttribute('role') === 'option'
                && el.innerText?.trim() === text && (el.offsetWidth || el.offsetHeight));
            if (!opt) return false;
            // long lists (languages) scroll inside the overlay; without this the option is
            // outside the scroll container's viewport and Puppeteer cannot click it
            opt.scrollIntoView({ block: 'center' });
            opt.dataset.cws = 'option';
            return true;
        }, text);
        await sleep(600);
        if (!ok) throw new Error(`option "${text}" not found`);
        await clickTag('option');
        await sleep(1200);
    };

    // each part is skippable so a failure late in the form doesn't force redoing the rest
    const only = process.argv[3];
    const want = (part) => !only || only === part;

    if (want('text')) {
    // 1. description
    if (!await tagByLabel('Description', 'description', { tag: 'textarea' })) throw new Error('Description field not found');
    // Two traps here. NOT .type(): 2374 keystrokes each trigger Angular change detection
    // and the CDP call times out. And NOT ElementHandle.evaluate on a `>>>`-pierced handle
    // either - that hangs too. page.evaluate against the tag is the one that works.
    const setOk = await page.evaluate((value) => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const el = all.find((e) => e.dataset?.cws === 'description');
        if (!el) return false;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        return el.value.length;
    }, description);
    if (!setOk) throw new Error('could not set description');
    console.error(`description set: ${setOk} chars in field`);
    console.error(`description: ${description.length} chars`);

    // 2. category + language
    if (!await tagByLabel('Category', 'category', { role: 'combobox' })) throw new Error('Category not found');
    await clickTag('category');
    await pickOption('Communication');
    console.error('category: Communication');

    if (!await tagByLabel('Language', 'language', { role: 'combobox' })) throw new Error('Language not found');
    await clickTag('language');
    await pickOption('English');
    console.error('language: English');

    }

    if (want('icon')) {
    // 3. graphic assets
    if (!await tagByLabel('Store icon', 'icon', { file: true })) throw new Error('Store icon input not found');
    await (await page.waitForSelector('>>> input[data-cws="icon"]'))
        .uploadFile(resolve('extensions/slack-ai-translate/store-icon-128.png'));
    await sleep(4000);
    console.error('store icon uploaded');
    }

    if (want('shots')) {
    // the screenshots input is NOT `multiple` - one file per upload, re-tagging each time
    // because the component re-renders after every accepted image
    for (const n of [1, 2, 3]) {
        if (!await tagByLabel('Screenshots', 'shots', { file: true })) throw new Error('Screenshots input not found');
        await (await page.waitForSelector('>>> input[data-cws="shots"]'))
            .uploadFile(resolve(`extensions/slack-ai-translate/store-screenshot-${n}.png`));
        await sleep(6000);
        console.error(`screenshot ${n} uploaded`);
    }
    }

    await recon(page, 'listing-filled');
    await browser.disconnect();
} else if (step === 'save') {
    const { browser, page } = await attach();
    const ok = await page.evaluate(() => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const btn = all.find((e) => e.tagName === 'BUTTON' && e.innerText?.trim() === 'Save draft'
            && (e.offsetWidth || e.offsetHeight));
        if (!btn) return false;
        btn.click();
        return true;
    });
    if (!ok) throw new Error('Save draft button not found');
    await sleep(6000);
    await recon(page, 'saved');
    console.error('saved draft');
    await browser.disconnect();
} else if (step === 'privacy') {
    const { browser, page } = await attach();
    const nav = await page.evaluate(() => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const link = all.find((e) => e.tagName === 'A' && e.innerText?.trim() === 'Privacy'
            && (e.offsetWidth || e.offsetHeight));
        if (!link) return false;
        link.click();
        return true;
    });
    if (!nav) throw new Error('Privacy nav link not found');
    await sleep(6000);

    const { readFileSync } = await import('node:fs');
    const md = readFileSync(resolve('extensions/slack-ai-translate/store-listing.md'), 'utf8');
    const b = [...md.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    const PRIVACY_URL = md.match(/\*\*Privacy policy URL:\*\*\s*(\S+)/)?.[1];
    if (!PRIVACY_URL?.startsWith('http')) throw new Error('privacy policy URL not found in store-listing.md');

    // label -> text. Labels come from the live form; the dashboard has ONE host-permission
    // field covering all four hosts, not one per host.
    const fills = [
        ['Single purpose description', b[2]],
        ['Host permission justification', b[3]],
        ['storage justification', b[4]],
        ['declarativeNetRequestWithHostAccess justification', b[5]],
    ];

    const filled = await page.evaluate((fills, url) => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const labelOf = (el) => {
            const by = el.getAttribute('aria-labelledby');
            if (by) {
                const t = by.split(/\s+/).map((i) => document.getElementById(i)?.innerText?.trim()).filter(Boolean).join(' ');
                if (t) return t;
            }
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
            let n = el.parentElement;
            for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
                const l = n.querySelector('label, .label, [class*=label]');
                if (l?.innerText?.trim()) return l.innerText.trim();
            }
            return '';
        };
        const set = (el, value) => {
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.blur();
        };
        const report = [];
        for (const [label, text] of fills) {
            const el = all.find((e) => e.tagName === 'TEXTAREA' && (e.offsetWidth || e.offsetHeight)
                && labelOf(e).startsWith(label));
            if (!el) { report.push(`MISSING: ${label}`); continue; }
            set(el, text);
            report.push(`${label}: ${el.value.length} chars`);
        }
        const urlEl = all.find((e) => e.tagName === 'INPUT' && e.type === 'text' && labelOf(e).startsWith('Privacy policy URL'));
        if (urlEl) { set(urlEl, url); report.push(`privacy url: ${urlEl.value}`); }
        else report.push('MISSING: privacy policy URL');

        // Data-usage categories that are true for this extension. The three developer
        // CERTIFICATION checkboxes are deliberately left alone - those are a legal
        // attestation by the developer, not something a script should tick.
        for (const want of ['Personal communications', 'Authentication information']) {
            const cb = all.find((e) => (e.getAttribute('role') === 'checkbox' || (e.tagName === 'INPUT' && e.type === 'checkbox'))
                && (e.offsetWidth || e.offsetHeight) && labelOf(e).startsWith(want));
            if (!cb) { report.push(`MISSING checkbox: ${want}`); continue; }
            const on = cb.getAttribute('aria-checked') === 'true' || cb.checked === true;
            if (!on) cb.click();
            report.push(`checked: ${want}`);
        }
        return report;
    }, fills, PRIVACY_URL);

    for (const line of filled) console.error(line);
    await sleep(2000);

    // Remote code: "No" is accurate - all executable code ships in the package, no eval,
    // no remotely-loaded script. Selecting it also retires the otherwise-required
    // remote-code Justification field. Separate from the field fills: this click
    // re-renders the section, and batching it once wedged the whole renderer.
    await pickRadio(page, 'No, I am not using remote code');
    console.error('remote code: No');

    await recon(page, 'privacy-filled');
    await browser.disconnect();
} else if (step === 'distribution') {
    const { browser, page } = await attach();
    const nav = await page.evaluate(() => {
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const link = all.find((e) => e.tagName === 'A' && e.innerText?.trim() === 'Distribution'
            && (e.offsetWidth || e.offsetHeight));
        if (!link) return false;
        link.click();
        return true;
    });
    if (!nav) throw new Error('Distribution nav link not found');
    await sleep(6000);

    // Visibility defaults to Public; this ships to colleagues by link, so Unlisted.
    await pickRadio(page, 'Unlisted');
    console.error('visibility: Unlisted');

    await recon(page, 'distribution');
    await browser.disconnect();
} else if (step === 'all') {
    await runAll();
} else if (step === 'attach') {
    const { browser, page } = await attach();
    for (let i = 0; i < 90; i++) {
        const url = page.url();
        if (!url.includes('accounts.google.com') && url.includes('devconsole')) {
            console.error(`>>> Attached, signed in: ${url}`);
            await recon(page, 'devconsole');
            break;
        }
        console.error(`   [${i}] ${url.slice(0, 110)}`);
        await sleep(8000);
    }
    // detach without closing: the window is the user's
    await browser.disconnect();
} else {
    console.error(`unknown step: ${step}`);
    process.exit(1);
}
