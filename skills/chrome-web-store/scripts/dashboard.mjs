// Drives the Chrome Web Store Developer Dashboard in a real browser, for the parts the
// CWS API cannot do: creating the item, the store-listing copy, screenshots, the privacy
// answers, and visibility.
//
// Sign in FIRST, by hand, in a normal Chrome - Google refuses its sign-in flow inside a
// Puppeteer-launched browser. This script only ever attaches to that session:
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 \
//     --user-data-dir="$HOME/.cache/chrome-web-store/chrome-profile" \
//     "https://chrome.google.com/webstore/devconsole" &
//
// Then, from the repo root:
//   node .../dashboard.mjs all extensions/<name>       # create + fill everything, save
//   node .../dashboard.mjs fill extensions/<name>      # fill an ALREADY-OPEN item
//   node .../dashboard.mjs status                      # what is filled / what blocks submit
//   node .../dashboard.mjs certify                     # tick the compliance attestations
//   node .../dashboard.mjs submit                      # submit for review (irreversible)
//
// Single steps, for repairs: newitem | upload | listing [text|icon|shots] | privacy |
//                            distribution | save
//
// `all` CREATES A NEW ITEM. To edit an existing listing, open it in the browser and use
// `fill` or the single steps, or you will end up with a duplicate.
//
// `certify` and `submit` are deliberately NOT part of `all`: the certifications are the
// developer's own legal attestation and submission cannot be undone. Run them only on an
// explicit instruction from the developer.
//
// Everything the dashboard taught us the hard way is in docs/CHROME-WEB-STORE-AUTOMATION.md.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const PROFILE_DIR = join(homedir(), '.cache', 'chrome-web-store', 'profile');
export const DEVCONSOLE = 'https://chrome.google.com/webstore/devconsole';
const OUT = join(homedir(), '.cache', 'chrome-web-store', 'recon');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(resolve('skills/greasyfork/scripts/') + '/');

// ---------------------------------------------------------------------------
// In-page helpers. Injected as a string into every page.evaluate: the dashboard is Angular
// Material, so nothing is reachable without walking shadow roots, and labels are the only
// stable handle (element ids are auto-generated - c11, c31 - and shift between renders).
// ---------------------------------------------------------------------------
const DOM = `
const __all = () => {
    const out = [];
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
    walk(document);
    return out;
};
const __vis = (el) => !!(el.offsetWidth || el.offsetHeight);
// resolution order: aria-labelledby, aria-label, then the nearest <label> up the tree.
// The Description textarea has ONLY the last of those.
const __label = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
        const t = by.split(/\\s+/).map((i) => document.getElementById(i)?.innerText?.trim()).filter(Boolean).join(' ');
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
// Only a real form control can hold text. __label walks UP the tree, so a plain
// "element whose label starts with X" match hits the section wrapper div long before the
// field itself - and assigning .value to a div succeeds silently, which is how a fill run
// once reported the right character counts for a tab that stayed empty.
const __editable = (el) => el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && ['text', 'url', 'search', 'email', ''].includes(el.type));
// text of the nearest ancestor that has any - how radios and checkboxes are identified
const __near = (el) => {
    let n = el, t = '';
    for (let i = 0; i < 5 && n && !t; i++, n = n.parentElement) t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    return t;
};
const __setValue = (el, value) => {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return el.value.length;
};
// An "Unable to publish"/"submitted" dialog swallows every later click. Always clear first.
const __dismiss = () => {
    const ok = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'OK' && __vis(e));
    if (ok) { ok.click(); return true; }
    return false;
};
`;

const evalPage = (page, fn, ...args) => page.evaluate(new Function('...a', `${DOM}\nreturn (${fn.toString()})(...a)`), ...args);

// ---------------------------------------------------------------------------
// Browser session
// ---------------------------------------------------------------------------
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

// Attach to the hand-signed-in Chrome. Never launches, never closes: the window is the
// user's, and on failure its state is the evidence.
export async function attach() {
    const puppeteer = require('puppeteer');
    let browser;
    try {
        browser = await puppeteer.connect({
            browserURL: 'http://localhost:9222',
            defaultViewport: null,
            protocolTimeout: 240000,
        });
    } catch (e) {
        throw new Error(
            'Cannot attach on port 9222. Start Chrome and sign in first:\n'
            + '  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n'
            + '    --remote-debugging-port=9222 \\\n'
            + `    --user-data-dir="$HOME/.cache/chrome-web-store/chrome-profile" &\n(${e.message})`
        );
    }
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes('chrome.google.com'))
        ?? pages.find((p) => p.url().includes('accounts.google.com'))
        ?? pages[0] ?? (await browser.newPage());
    if (page.url().includes('accounts.google.com')) {
        await browser.disconnect();
        throw new Error('That Chrome is signed out. Sign in to the dashboard in it, then re-run.');
    }
    // An occluded or background tab stops producing frames, and anything that waits on the
    // compositor - notably Puppeteer's ElementHandle.click, which scrolls into view first -
    // then blocks for the whole protocolTimeout. Raising the tab is what makes an unattended
    // run behave like a watched one.
    await page.bringToFront().catch(() => {});
    // A native dialog blocks the renderer, and every later CDP call - even attaching -
    // then times out with no hint why. The dashboard raises beforeunload on any navigation
    // with unsaved edits, so without this an unattended run wedges permanently.
    page.on('dialog', async (d) => {
        console.error(`dismissing ${d.type()} dialog: ${d.message().slice(0, 60)}`);
        await d.accept().catch(() => {});
    });
    await evalPage(page, () => __dismiss());
    return { browser, page };
}

export async function recon(page, label) {
    mkdirSync(OUT, { recursive: true });
    const shot = join(OUT, `${label}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const controls = await evalPage(page, () => __all()
        .filter((el) => {
            const t = el.tagName.toLowerCase();
            return (/^(button|input|textarea|select|a)$/.test(t) || el.getAttribute('role') === 'button') && __vis(el);
        })
        .map((el) => ({
            tag: el.tagName.toLowerCase(), type: el.getAttribute('type'),
            aria: el.getAttribute('aria-label'), label: __label(el).slice(0, 60),
            text: (el.innerText || '').trim().slice(0, 60) || null,
        })));
    const dump = join(OUT, `${label}.json`);
    writeFileSync(dump, JSON.stringify({ url: page.url(), controls }, null, 2));
    console.error(`recon: ${shot}`);
    return { shot, dump, controls };
}

// ---------------------------------------------------------------------------
// Verified interactions. Every one of these re-reads the page afterwards and throws if the
// change did not land: silently-ineffective clicks were by far the worst failure mode here
// (a label click on a Material radio looks fine and does nothing).
// ---------------------------------------------------------------------------

// Click via real mouse events at a computed point. ElementHandle.click() on a `>>>`-pierced
// shadow element either throws "not clickable" or hangs the CDP call.
async function clickAt(page, locate, what) {
    const box = await evalPage(page, locate);
    if (!box) throw new Error(`cannot locate ${what}`);
    await sleep(400);
    await page.mouse.click(box.x, box.y);
    await sleep(1000);
}

const rectOf = `(el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }`;

// Text goes in as real browser input (Input.insertText), never as `el.value = …`. Assigning
// the property leaves the DOM looking right while the form's own model stays empty, so the
// read-back passes, the next re-render repaints the field from that empty model, and the
// draft saves blank. Symptom: a fill run reports the right character counts and the tab is
// empty afterwards. sendCharacter inserts the whole string in one CDP call, so it is also
// not the per-keystroke .type() that times out on a long description.
export async function setField(page, labelPrefix, value, opts = {}) {
    const box = await evalPage(page, (labelPrefix, opts) => {
        const el = __all().find((e) => __vis(e) && __editable(e)
            && (!opts.tag || e.tagName.toLowerCase() === opts.tag)
            && __label(e).startsWith(labelPrefix));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, labelPrefix, opts);
    if (!box) throw new Error(`field "${labelPrefix}" not found`);

    await page.mouse.click(box.x, box.y);
    await sleep(300);
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.sendCharacter(value);
    await sleep(400);

    const len = await evalPage(page, (labelPrefix, opts) => {
        const el = __all().find((e) => __vis(e) && __editable(e)
            && (!opts.tag || e.tagName.toLowerCase() === opts.tag)
            && __label(e).startsWith(labelPrefix));
        if (!el) return -1;
        el.blur();
        return (el.value || '').length;
    }, labelPrefix, opts);
    if (len === -1) throw new Error(`field "${labelPrefix}" vanished while typing`);
    if (len !== value.length) throw new Error(`field "${labelPrefix}" holds ${len} chars, expected ${value.length}`);
    return len;
}

// Material radios ignore clicks on their label text. Find the real input[type=radio] by the
// nearest ancestor text, click it, then confirm `checked`.
export async function pickRadio(page, labelPrefix) {
    const find = `(p) => __all().filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => __near(e).startsWith(p))`;
    await clickAt(page, new Function('p', `${DOM}\nconst el = (${find})(p); return el ? (${rectOf})(el) : null;`).bind(null),
        `radio "${labelPrefix}"`).catch(async () => {
        // clickAt takes a zero-arg fn; fall back to an inline evaluate that closes over the label
        const box = await evalPage(page, (p) => {
            const el = __all().filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => __near(e).startsWith(p));
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }, labelPrefix);
        if (!box) throw new Error(`radio "${labelPrefix}" not found`);
        await sleep(400);
        await page.mouse.click(box.x, box.y);
        await sleep(1200);
    });
    const checked = await evalPage(page, (p) => {
        const el = __all().filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => __near(e).startsWith(p));
        return !!el?.checked;
    }, labelPrefix);
    if (!checked) throw new Error(`radio "${labelPrefix}" did not take - the click was swallowed`);
    return true;
}

export async function setCheckbox(page, labelPrefix, want = true, optional = false) {
    const state = await evalPage(page, (p, want) => {
        const cb = __all().find((e) => e.tagName === 'INPUT' && e.type === 'checkbox' && __vis(e) && __near(e).startsWith(p));
        if (!cb) return null;
        if (cb.checked !== want) cb.click();
        return cb.checked;
    }, labelPrefix, want);
    if (state === null) {
        if (optional) return null;
        throw new Error(`checkbox "${labelPrefix}" not found`);
    }
    if (state !== want) throw new Error(`checkbox "${labelPrefix}" is ${state}, wanted ${want}`);
    return state;
}

// The dashboard's data-collection types. Every one is set explicitly from store-listing.md,
// so a declaration is the same whether the item is new or is being corrected - leaving a box
// alone would silently keep a claim the listing no longer makes.
export const DATA_CATEGORIES = [
    'Personally identifiable information', 'Health information', 'Financial and payment information',
    'Authentication information', 'Personal communications', 'Location', 'Web history',
    'User activity', 'Website content',
];

// Comboboxes: open, then pick. Options exist in the DOM while closed (0x0), so visibility is
// what distinguishes an open menu; long lists scroll inside their own overlay, so the option
// must be scrolled into view before it has a clickable point.
export async function pickCombo(page, labelPrefix, optionText) {
    const box = await evalPage(page, (p) => {
        const el = __all().find((e) => e.getAttribute('role') === 'combobox' && __vis(e) && __label(e).startsWith(p));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, labelPrefix);
    if (!box) throw new Error(`combobox "${labelPrefix}" not found`);
    await sleep(400);
    await page.mouse.click(box.x, box.y);
    await sleep(1500);

    const optBox = await evalPage(page, (text) => {
        const opt = __all().find((e) => e.getAttribute('role') === 'option' && __vis(e) && (e.innerText || '').trim() === text);
        if (!opt) return null;
        opt.scrollIntoView({ block: 'center' });
        return null; // rect is stale right after scrolling; re-read below
    }, optionText) ?? await (async () => {
        await sleep(600);
        return evalPage(page, (text) => {
            const opt = __all().find((e) => e.getAttribute('role') === 'option' && __vis(e) && (e.innerText || '').trim() === text);
            if (!opt) return null;
            const r = opt.getBoundingClientRect();
            return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }, optionText);
    })();
    if (!optBox) throw new Error(`option "${optionText}" not found - is the menu open?`);
    await page.mouse.click(optBox.x, optBox.y);
    await sleep(1500);

    const shown = await evalPage(page, (p) => {
        const el = __all().find((e) => e.getAttribute('role') === 'combobox' && __vis(e) && __label(e).startsWith(p));
        return (el?.innerText || '').replace(/\s+/g, ' ').trim();
    }, labelPrefix);
    if (!shown.includes(optionText)) throw new Error(`combobox "${labelPrefix}" shows "${shown}", expected "${optionText}"`);
    return shown;
}

export async function uploadTo(page, labelPrefix, file) {
    if (!existsSync(file)) throw new Error(`file not found: ${file}`);
    const tagged = await evalPage(page, (p) => {
        document.querySelectorAll('[data-cws="up"]').forEach((e) => delete e.dataset.cws);
        const anchor = __all().find((e) => __vis(e) && __label(e).startsWith(p));
        if (!anchor) return false;
        let n = anchor, input = null;
        for (let i = 0; i < 6 && n && !input; i++, n = n.parentElement) input = n.querySelector?.('input[type=file]');
        if (!input) return false;
        input.dataset.cws = 'up';
        return true;
    }, labelPrefix);
    if (!tagged) throw new Error(`file input for "${labelPrefix}" not found`);
    // this input is NOT `multiple` - one file per call
    const handle = await page.waitForSelector('>>> input[data-cws="up"]', { timeout: 20000 });
    await handle.uploadFile(file);
    await sleep(5000);
}

export async function saveDraft(page) {
    const ok = await evalPage(page, () => {
        __dismiss();
        const btn = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'Save draft' && __vis(e));
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
    });
    if (!ok) throw new Error('Save draft not available (already saved, or the page is blocked by a dialog)');
    await sleep(6000);
    console.error('saved draft');
}

// ---------------------------------------------------------------------------
// Listing config, read from the extension's own store-listing.md so the repo stays the
// source of truth and nothing about a specific extension is hardcoded here.
// ---------------------------------------------------------------------------
export function readListing(extDir) {
    const md = readFileSync(join(extDir, 'store-listing.md'), 'utf8');
    const blocks = [...md.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    const bullet = (name) => md.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`))?.[1]?.trim();
    const section = (heading) => {
        const re = new RegExp(`\\*\\*${heading}[^*]*\\*\\*[^\`]*\`\`\`\\n([\\s\\S]*?)\\n\`\`\``);
        return md.match(re)?.[1];
    };
    const cfg = {
        description: blocks.find((b) => b.length > 500),
        singlePurpose: section('Single purpose') ?? blocks[2],
        hostJustification: section('Host permission justification'),
        category: (bullet('Category') || '').match(/^([^(]+)/)?.[1]?.trim(),
        language: bullet('Language') || 'English',
        visibility: (bullet('Visibility') || 'Unlisted').split(/[\s(]/)[0],
        privacyUrl: (bullet('Privacy policy URL') || '').split(/\s/)[0],
        icon: join(extDir, 'store-icon-128.png'),
        screenshots: [1, 2, 3, 4, 5].map((n) => join(extDir, `store-screenshot-${n}.png`)).filter(existsSync),
        // permission -> justification, keyed by the dashboard's own field labels
        permissions: Object.fromEntries(
            [...md.matchAll(/\*\*`([a-zA-Z]+)`\*\*\n\n```\n([\s\S]*?)\n```/g)].map((m) => [m[1], m[2]])
        ),
        // data-collection types to declare: the bolded bullets under "## Data usage".
        // An extension that collects nothing declares none, and the section says so in prose.
        dataUsage: [...(md.match(/##\s*Data usage[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '')
            .matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1].trim()),
    };
    const unknown = cfg.dataUsage.filter((c) => !DATA_CATEGORIES.includes(c));
    if (unknown.length) throw new Error(`unknown data-usage categories: ${unknown.join(', ')}`);
    const missing = Object.entries({
        description: cfg.description, singlePurpose: cfg.singlePurpose, category: cfg.category,
        privacyUrl: cfg.privacyUrl, hostJustification: cfg.hostJustification,
    }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`store-listing.md is missing: ${missing.join(', ')}`);
    if (!existsSync(cfg.icon)) throw new Error(`missing store icon: ${cfg.icon}`);
    if (!cfg.screenshots.length) throw new Error('no store-screenshot-N.png found');
    if (!cfg.privacyUrl.startsWith('http')) throw new Error(`bad privacy URL: ${cfg.privacyUrl}`);
    return cfg;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function goTab(page, tab) {
    const ok = await evalPage(page, (tab) => {
        __dismiss();
        const link = __all().find((e) => e.tagName === 'A' && e.innerText?.trim() === tab && __vis(e));
        if (!link) return false;
        link.click();
        return true;
    }, tab);
    if (!ok) throw new Error(`nav link "${tab}" not found`);
    await sleep(6000);
}

async function fillListing(page, cfg, only) {
    const want = (p) => !only || only === p;
    if (want('text')) {
        console.error(`description: ${await setField(page, 'Description', cfg.description, { tag: 'textarea' })} chars`);
        console.error(`category: ${await pickCombo(page, 'Category', cfg.category)}`);
        console.error(`language: ${await pickCombo(page, 'Language', cfg.language)}`);
    }
    if (want('icon')) {
        await uploadTo(page, 'Store icon', cfg.icon);
        console.error('store icon uploaded');
    }
    if (want('shots')) {
        for (const [i, shot] of cfg.screenshots.entries()) {
            await uploadTo(page, 'Screenshots', shot);
            console.error(`screenshot ${i + 1} uploaded: ${basename(shot)}`);
        }
    }
}

async function fillPrivacy(page, cfg) {
    await goTab(page, 'Privacy');
    console.error(`single purpose: ${await setField(page, 'Single purpose description', cfg.singlePurpose)} chars`);
    console.error(`host justification: ${await setField(page, 'Host permission justification', cfg.hostJustification)} chars`);
    for (const [perm, text] of Object.entries(cfg.permissions)) {
        console.error(`${perm}: ${await setField(page, `${perm} justification`, text)} chars`);
    }
    console.error(`privacy url: ${await setField(page, 'Privacy policy URL', cfg.privacyUrl)} chars`);
    for (const cat of DATA_CATEGORIES) {
        const want = cfg.dataUsage.includes(cat);
        const state = await setCheckbox(page, cat, want, true);
        if (state === null && want) throw new Error(`data-usage category "${cat}" not found on the page`);
        if (state !== null) console.error(`data usage: ${cat} = ${state}`);
    }
    // Separate from the field fills on purpose: this click re-renders the section, and
    // batching it into the same evaluate once wedged the whole renderer.
    await pickRadio(page, 'No, I am not using remote code');
    console.error('remote code: No');
}

async function fillDistribution(page, cfg) {
    await goTab(page, 'Distribution');
    await pickRadio(page, cfg.visibility);
    console.error(`visibility: ${cfg.visibility}`);
}

// What is actually filled, and what the dashboard says still blocks submission.
async function reportStatus(page) {
    const st = await evalPage(page, () => {
        const submit = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'Submit for review');
        return {
            // "Status: Pending review  ID: abc..." - stop at the ID, not at the first space
            status: document.body.innerText.match(/Status:\s*(.+?)\s*(?:ID:|\n|$)/)?.[1]?.trim(),
            id: document.body.innerText.match(/ID:\s*([a-p]{32})/)?.[1],
            submitDisabled: submit ? (submit.disabled || submit.getAttribute('aria-disabled') === 'true') : null,
        };
    });
    // the dashboard's own validator is the only trustworthy list of blockers
    await evalPage(page, () => {
        const b = __all().find((e) => (e.innerText || '').includes("Why can't I submit") && e.tagName === 'BUTTON' && __vis(e));
        if (b) b.click();
    });
    await sleep(2500);
    const blockers = await evalPage(page, () => {
        const dlg = __all().find((e) => e.getAttribute('role') === 'dialog' && __vis(e));
        const t = dlg ? dlg.innerText.replace(/\s+/g, ' ').trim() : '';
        __dismiss();
        return t;
    });
    return { ...st, blockers: blockers || '(none reported)' };
}

// ---------------------------------------------------------------------------
// CLI. Importing this module must never launch a browser - it once did, spawning a second
// Chrome that tripped Google's automation block.
// ---------------------------------------------------------------------------
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
    const step = process.argv[2] || 'status';
    const arg = process.argv[3];
    const extDir = arg && arg.startsWith('extensions/') ? arg : 'extensions/slack-ai-translate';

    if (step === 'login') {
        const { page } = await launchBrowser();
        console.error('Sign in to Google in this window, then use the attach-based steps.');
        console.error('If Google refuses ("browser may not be secure"), that is expected -');
        console.error('start Chrome yourself with --remote-debugging-port=9222 instead. See the header.');
        await sleep(5000);
        await recon(page, 'login');

    } else if (step === 'newitem') {
        const { browser, page } = await attach();
        // networkidle2 never fires on this SPA; wait for the control, not the network
        await page.goto(DEVCONSOLE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('>>> button[aria-label="Add a new item"]', { timeout: 60000 });
        // In-page click, like every other interaction here. ElementHandle.click scrolls into
        // view via the compositor and hangs for the full protocolTimeout on a tab Chrome is
        // not painting; a plain el.click() needs no frames.
        const clicked = await evalPage(page, () => {
            __dismiss();
            const btn = __all().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Add a new item' && __vis(e));
            if (!btn) return false;
            btn.click();
            return true;
        });
        if (!clicked) throw new Error('Add-new-item button not found');
        await sleep(4000);
        const ready = await evalPage(page, () => !!__all().find((e) => e.tagName === 'INPUT' && e.type === 'file'));
        if (!ready) throw new Error('Add-new-item dialog did not open');
        console.error('new item dialog open');
        await browser.disconnect();

    } else if (step === 'upload') {
        const zip = resolve(arg && arg.endsWith('.zip') ? arg : `${extDir}-cws.zip`);
        if (!existsSync(zip)) throw new Error(`zip not found: ${zip} (run make-zip.mjs first)`);
        const { browser, page } = await attach();
        const input = await page.waitForSelector('>>> input[type=file]', { timeout: 30000 });
        console.error(`uploading ${zip}`);
        await input.uploadFile(zip);
        await sleep(10000);
        if (!/\/edit/.test(page.url())) throw new Error(`upload did not open an edit page (url: ${page.url()})`);
        const id = page.url().match(/\/([a-p]{32})\//)?.[1];
        console.error(`item id: ${id}`);
        await browser.disconnect();

    } else if (step === 'listing') {
        const cfg = readListing(extDir);
        const { browser, page } = await attach();
        await page.keyboard.press('Escape').catch(() => {});
        await fillListing(page, cfg, process.argv[4]);
        await browser.disconnect();

    } else if (step === 'privacy') {
        const cfg = readListing(extDir);
        const { browser, page } = await attach();
        await fillPrivacy(page, cfg);
        await browser.disconnect();

    } else if (step === 'distribution') {
        const cfg = readListing(extDir);
        const { browser, page } = await attach();
        await fillDistribution(page, cfg);
        await browser.disconnect();

    } else if (step === 'save') {
        const { browser, page } = await attach();
        await saveDraft(page);
        await browser.disconnect();

    } else if (step === 'fill') {
        // everything except item creation - for an item already open in the browser
        const cfg = readListing(extDir);
        const { browser, page } = await attach();
        await page.keyboard.press('Escape').catch(() => {});
        await fillListing(page, cfg);
        await saveDraft(page);
        await fillPrivacy(page, cfg);
        await saveDraft(page);
        await fillDistribution(page, cfg);
        await saveDraft(page);
        console.error(JSON.stringify(await reportStatus(page), null, 1));
        await browser.disconnect();

    } else if (step === 'all') {
        readListing(extDir); // fail before touching the browser if the config is wrong
        console.error(`\n!! 'all' CREATES A NEW ITEM. Use 'fill' to edit an existing one.\n`);
        for (const s of ['newitem', 'upload', 'fill']) {
            console.error(`\n=== ${s} ===`);
            execSync(`node ${process.argv[1]} ${s} ${extDir}`, { stdio: 'inherit' });
        }
        console.error('\nDone. The item is a saved Draft.');
        console.error('Left for the developer: `certify` then `submit`.');

    } else if (step === 'status') {
        const { browser, page } = await attach();
        console.error(JSON.stringify(await reportStatus(page), null, 1));
        await browser.disconnect();

    } else if (step === 'certify') {
        // The developer's compliance attestation. Only on their explicit instruction, and
        // only after confirming each statement is true of this extension.
        const { browser, page } = await attach();
        await goTab(page, 'Privacy');
        const boxes = await evalPage(page, () => __all()
            .filter((e) => e.tagName === 'INPUT' && e.type === 'checkbox' && __vis(e) && __near(e).startsWith('I do not'))
            .map((e) => __near(e).slice(0, 60)));
        if (boxes.length !== 3) throw new Error(`expected 3 certification boxes, found ${boxes.length}`);
        for (const b of boxes) {
            await setCheckbox(page, b.slice(0, 40), true);
            console.error(`[x] ${b}`);
        }
        await saveDraft(page);
        await browser.disconnect();

    } else if (step === 'submit') {
        const { browser, page } = await attach();
        const before = await reportStatus(page);
        // the button stays enabled after a successful submission, so status is the guard
        if (before.status && !/^Draft/i.test(before.status)) {
            throw new Error(`item is already "${before.status}" - nothing to submit`);
        }
        if (before.submitDisabled) throw new Error(`cannot submit - blockers: ${before.blockers}`);
        const opened = await evalPage(page, () => {
            const btn = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'Submit for review');
            if (!btn || btn.disabled) return false;
            btn.click();
            return true;
        });
        if (!opened) throw new Error('Submit for review button not clickable');
        await sleep(6000);
        // that button only OPENS a confirmation dialog; the dialog's own button submits
        const confirmed = await evalPage(page, () => {
            const btn = __all().find((e) => ['BUTTON', 'A'].includes(e.tagName)
                && (e.innerText || '').trim() === 'Submit For Review' && __vis(e));
            if (!btn) return false;
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return true;
        });
        if (!confirmed) throw new Error('confirmation dialog did not appear - nothing was submitted');
        // the status header lags the submission by several seconds; poll rather than
        // reading once and reporting a stale "Draft"
        let status = null;
        for (let i = 0; i < 36; i++) {
            await sleep(5000);
            status = (await reportStatus(page)).status;
            if (status && !/^Draft/i.test(status)) break;
            console.error(`   waiting for status to flip (${status})`);
        }
        await recon(page, 'submitted');
        console.error(`status: ${status}`);
        // The header can lag the submission by minutes. Re-read with `status` before
        // believing this and never re-submit on it - that is how duplicates happen.
        if (/^Draft/i.test(status || '')) {
            throw new Error('still Draft after 3 minutes - re-run `status` before assuming it failed');
        }

    } else {
        console.error(`unknown step: ${step}`);
        console.error('steps: all | fill | newitem | upload | listing | privacy | distribution | save | status | certify | submit');
        process.exit(1);
    }
}
