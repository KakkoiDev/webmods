// Drives the Chrome Web Store Developer Dashboard in a real browser, for the parts the
// CWS API cannot do: creating the item, the store-listing copy, screenshots, and the
// privacy answers. Same shape as the greasyfork skill's release.mjs - headful Chrome on a
// persisted profile, you sign in once by hand, later runs reuse the session.
//
//   node skills/chrome-web-store/scripts/dashboard.mjs login     # sign in + recon dump
//
// It deliberately never ticks the developer certification checkboxes and never presses
// Submit: those are your legal attestation, not the script's.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

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
        await page.goto(DEVCONSOLE, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
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

// Google refuses its sign-in flow inside a Puppeteer-launched Chrome ("This browser or app
// may not be secure"). So we never sign in under automation: the user launches a normal
// Chrome with a debugging port on a dedicated profile, signs in there, and we attach to the
// already-authenticated session. Chrome blocks --remote-debugging-port on the DEFAULT
// profile, hence the separate --user-data-dir.
export async function attach() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes('chrome.google.com') || p.url().includes('accounts.google.com'))
        ?? pages[0] ?? (await browser.newPage());
    return { browser, page };
}

const step = process.argv[2] || 'login';

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
