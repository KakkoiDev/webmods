// The browser half of dashboard.mjs. This file is not run by node: dashboard.mjs
// reads it and feeds it to `ego-browser nodejs`, which executes it inside the
// browser's own Node runtime. It is a separate file only because that runtime
// takes source text, not a Page object - keeping it here means it stays ordinary,
// lintable JavaScript instead of a giant template literal.
//
// It gets its arguments as INPUT (prepended by dashboard.mjs) and returns through
// emit(). Notes on the runtime, each one learned the hard way:
//   - `require` cannot be used at all: this script has top-level await, and Node
//     refuses a source containing both. Use `await import(...)`.
//   - js() auto-wraps a source containing a top-level `return` in an IIFE, which
//     throws away the value. Every evaluate here is ONE explicit IIFE.
//   - There is no argument channel into the page: js() takes a string. evalPage
//     serializes arguments into the source instead.

const fs = await import('node:fs');

const DEVCONSOLE = 'https://chrome.google.com/webstore/devconsole';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ego-browser holds cliLog output until this process exits, so progress that the
// user needs while a long step is still running goes to a file dashboard.mjs
// tails, and the step's return value to a second file it reads afterwards.
const log = (m) => fs.appendFileSync(INPUT.progress, m + '\n');
const emit = (v) => fs.writeFileSync(INPUT.result, JSON.stringify(v === undefined ? null : v));

// Reused, never completed: closing the space would throw away both the signed-in
// session and the item left open for the next step.
const task = await useOrCreateTaskSpace(INPUT.task);

// ---------------------------------------------------------------------------
// In-page helpers. Injected as a string into every evaluate: the dashboard is Angular
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
// An "Unable to publish"/"submitted" dialog swallows every later click. Always clear first.
const __dismiss = () => {
    const ok = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'OK' && __vis(e));
    if (ok) { ok.click(); return true; }
    return false;
};
`;

// js() takes a string and gives the page no argument channel, so arguments are
// serialized into the source. One explicit IIFE, never a bare `return`.
const evalPage = (fn, ...args) => js(
    `(() => {\n${DOM}\nreturn (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')});\n})()`,
);

// ---------------------------------------------------------------------------
// Browser session
//
// There is no browser to launch or attach to any more: ego-browser owns the
// window, and the named task space keeps its tabs alive between runs of this
// script, which is what lets `newitem` hand an open item to `upload` and `fill`.
// So the equivalent of attach() is "find the dashboard tab and select it".
// ---------------------------------------------------------------------------
async function dismissNativeDialog() {
    // A native dialog blocks the renderer and every later CDP call then times out with no
    // hint why. The dashboard raises beforeunload on any navigation with unsaved edits, so
    // without this an unattended run wedges permanently.
    const info = await pageInfo();
    if (info && info.dialog) {
        await cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        return true;
    }
    return false;
}

async function attach() {
    const tabs = await listTabs();
    const pick = tabs.find((t) => /chrome\.google\.com|chromewebstore\.google\.com/.test(t.url))
        ?? tabs.find((t) => t.url.includes('accounts.google.com'));
    if (!pick) {
        throw new Error('No Chrome Web Store tab in this task space. Run `dashboard.mjs login` first.');
    }
    await switchTab(pick.targetId);
    await dismissNativeDialog();
    if ((await pageInfo()).url.includes('accounts.google.com')) {
        throw new Error('That session is signed out. Sign in to the dashboard in the ego-browser window, then re-run.');
    }
    await evalPage(() => __dismiss());
    return pick;
}

// Diagnostic only: a picture of the page and every control on it, for working out why a
// step did not do what it should have.
async function recon(label) {
    fs.mkdirSync(INPUT.out, { recursive: true });
    let shot = null;
    // captureScreenshot() silently ignores fullPage, so the full-page capture is
    // done through CDP and written here.
    //
    // A screenshot is the one thing here that needs a composited surface. ego-browser
    // keeps its tabs alive with no window on screen, and a renderer with no window
    // produces no frame, so Page.captureScreenshot blocks until CDP times out - on a
    // page every other call reads and drives perfectly. Losing the picture must not
    // fail the step; the control dump below is what an unattended run is read from.
    try {
        const size = (await cdp('Page.getLayoutMetrics')).cssContentSize;
        const png = await cdp('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
        });
        shot = INPUT.out + '/' + label + '.png';
        fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    } catch (e) {
        shot = null;
        log(`recon: no screenshot (${e.message}) - open the ego-browser window if you want one`);
    }
    const controls = await evalPage(() => __all()
        .filter((el) => {
            const t = el.tagName.toLowerCase();
            return (/^(button|input|textarea|select|a)$/.test(t) || el.getAttribute('role') === 'button') && __vis(el);
        })
        .map((el) => ({
            tag: el.tagName.toLowerCase(), type: el.getAttribute('type'),
            aria: el.getAttribute('aria-label'), label: __label(el).slice(0, 60),
            text: (el.innerText || '').trim().slice(0, 60) || null,
        })));
    const dump = INPUT.out + '/' + label + '.json';
    fs.writeFileSync(dump, JSON.stringify({ url: (await pageInfo()).url, controls }, null, 2));
    log(`recon: ${shot ?? dump}`);
    return { shot, dump, controls };
}

// ---------------------------------------------------------------------------
// Verified interactions. Every one of these re-reads the page afterwards and throws if the
// change did not land: silently-ineffective clicks were by far the worst failure mode here
// (a label click on a Material radio looks fine and does nothing).
// ---------------------------------------------------------------------------

// Click via real mouse events at a computed point. Selector-based helpers use
// document.querySelector, which reaches nothing inside these shadow roots.
async function clickAt(box, what) {
    if (!box) throw new Error(`cannot locate ${what}`);
    await sleep(400);
    await click([box.x, box.y]);
    await sleep(1000);
}

// Text goes in as real browser input (Input.insertText), never as `el.value = …`. Assigning
// the property leaves the DOM looking right while the form's own model stays empty, so the
// read-back passes, the next re-render repaints the field from that empty model, and the
// draft saves blank. Symptom: a fill run reports the right character counts and the tab is
// empty afterwards. insertText puts the whole string in with one CDP call, so it is also
// not the per-keystroke typing that times out on a long description.
//
// The selection is made with setSelectionRange rather than a select-all chord:
// pressKey('Meta+a') is accepted and selects nothing, so the new text would be
// appended to the old instead of replacing it - verified, 2605 chars where 5 were
// expected. setSelectionRange only moves the caret; the replacement itself is
// still a real renderer input event.
async function setField(labelPrefix, value, opts = {}) {
    const box = await evalPage((labelPrefix, opts) => {
        const el = __all().find((e) => __vis(e) && __editable(e)
            && (!opts.tag || e.tagName.toLowerCase() === opts.tag)
            && __label(e).startsWith(labelPrefix));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, labelPrefix, opts);
    if (!box) throw new Error(`field "${labelPrefix}" not found`);

    await click([box.x, box.y]);
    await sleep(300);
    const selected = await evalPage((labelPrefix, opts) => {
        const el = __all().find((e) => __vis(e) && __editable(e)
            && (!opts.tag || e.tagName.toLowerCase() === opts.tag)
            && __label(e).startsWith(labelPrefix));
        if (!el) return false;
        el.focus();
        el.setSelectionRange(0, (el.value || '').length);
        return true;
    }, labelPrefix, opts);
    if (!selected) throw new Error(`field "${labelPrefix}" vanished before typing`);
    await cdp('Input.insertText', { text: value });
    await sleep(400);

    const len = await evalPage((labelPrefix, opts) => {
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
async function pickRadio(labelPrefix) {
    const box = await evalPage((p) => {
        const el = __all().filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => __near(e).startsWith(p));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, labelPrefix);
    await clickAt(box, `radio "${labelPrefix}"`);
    const checked = await evalPage((p) => {
        const el = __all().filter((e) => e.tagName === 'INPUT' && e.type === 'radio').find((e) => __near(e).startsWith(p));
        return !!el?.checked;
    }, labelPrefix);
    if (!checked) throw new Error(`radio "${labelPrefix}" did not take - the click was swallowed`);
    return true;
}

async function setCheckbox(labelPrefix, want = true, optional = false) {
    const state = await evalPage((p, want) => {
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

// Comboboxes: open, then pick. Options exist in the DOM while closed (0x0), so visibility is
// what distinguishes an open menu; long lists scroll inside their own overlay, so the option
// must be scrolled into view before it has a clickable point.
async function pickCombo(labelPrefix, optionText) {
    const box = await evalPage((p) => {
        const el = __all().find((e) => e.getAttribute('role') === 'combobox' && __vis(e) && __label(e).startsWith(p));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, labelPrefix);
    if (!box) throw new Error(`combobox "${labelPrefix}" not found`);
    await sleep(400);
    await click([box.x, box.y]);
    await sleep(1500);

    // rect is stale right after scrolling, so scroll first and re-read it
    await evalPage((text) => {
        const opt = __all().find((e) => e.getAttribute('role') === 'option' && __vis(e) && (e.innerText || '').trim() === text);
        if (opt) opt.scrollIntoView({ block: 'center' });
        return null;
    }, optionText);
    await sleep(600);
    const optBox = await evalPage((text) => {
        const opt = __all().find((e) => e.getAttribute('role') === 'option' && __vis(e) && (e.innerText || '').trim() === text);
        if (!opt) return null;
        const r = opt.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, optionText);
    if (!optBox) throw new Error(`option "${optionText}" not found - is the menu open?`);
    await click([optBox.x, optBox.y]);
    await sleep(1500);

    const shown = await evalPage((p) => {
        const el = __all().find((e) => e.getAttribute('role') === 'combobox' && __vis(e) && __label(e).startsWith(p));
        return (el?.innerText || '').replace(/\s+/g, ' ').trim();
    }, labelPrefix);
    if (!shown.includes(optionText)) throw new Error(`combobox "${labelPrefix}" shows "${shown}", expected "${optionText}"`);
    return shown;
}

// uploadFile() resolves its selector with document.querySelector, which cannot see
// into a shadow root, so the input is reached by evaluating to an objectId and
// handing that straight to DOM.setFileInputFiles.
async function uploadTo(labelPrefix, file) {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const tagged = await evalPage((p) => {
        __all().forEach((e) => { if (e.dataset && e.dataset.cws === 'up') delete e.dataset.cws; });
        const anchor = __all().find((e) => __vis(e) && __label(e).startsWith(p));
        if (!anchor) return false;
        let n = anchor, input = null;
        for (let i = 0; i < 6 && n && !input; i++, n = n.parentElement) input = n.querySelector?.('input[type=file]');
        if (!input) return false;
        input.dataset.cws = 'up';
        return true;
    }, labelPrefix);
    if (!tagged) throw new Error(`file input for "${labelPrefix}" not found`);
    const handle = await cdp('Runtime.evaluate', {
        expression: `(() => {${DOM}\nreturn __all().find((e) => e.dataset && e.dataset.cws === 'up');})()`,
    });
    if (!handle.result?.objectId) throw new Error(`file input for "${labelPrefix}" vanished before upload`);
    // this input is NOT `multiple` - one file per call
    await cdp('DOM.setFileInputFiles', { objectId: handle.result.objectId, files: [file] });
    await sleep(5000);
}

async function saveDraft() {
    const ok = await evalPage(() => {
        __dismiss();
        const btn = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'Save draft' && __vis(e));
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
    });
    if (!ok) throw new Error('Save draft not available (already saved, or the page is blocked by a dialog)');
    await sleep(6000);
    log('saved draft');
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function goTab(tab) {
    const ok = await evalPage((tab) => {
        __dismiss();
        const link = __all().find((e) => e.tagName === 'A' && e.innerText?.trim() === tab && __vis(e));
        if (!link) return false;
        link.click();
        return true;
    }, tab);
    if (!ok) throw new Error(`nav link "${tab}" not found`);
    await sleep(6000);
}

async function fillListing(cfg, only) {
    const want = (p) => !only || only === p;
    if (want('text')) {
        log(`description: ${await setField('Description', cfg.description, { tag: 'textarea' })} chars`);
        log(`category: ${await pickCombo('Category', cfg.category)}`);
        log(`language: ${await pickCombo('Language', cfg.language)}`);
    }
    if (want('icon')) {
        await uploadTo('Store icon', cfg.icon);
        log('store icon uploaded');
    }
    if (want('shots')) {
        for (const [i, shot] of cfg.screenshots.entries()) {
            await uploadTo('Screenshots', shot);
            log(`screenshot ${i + 1} uploaded: ${shot.split('/').pop()}`);
        }
    }
}

async function fillPrivacy(cfg) {
    await goTab('Privacy');
    log(`single purpose: ${await setField('Single purpose description', cfg.singlePurpose)} chars`);
    log(`host justification: ${await setField('Host permission justification', cfg.hostJustification)} chars`);
    for (const [perm, text] of Object.entries(cfg.permissions)) {
        log(`${perm}: ${await setField(`${perm} justification`, text)} chars`);
    }
    log(`privacy url: ${await setField('Privacy policy URL', cfg.privacyUrl)} chars`);
    for (const cat of INPUT.dataCategories) {
        const want = cfg.dataUsage.includes(cat);
        const state = await setCheckbox(cat, want, true);
        if (state === null && want) throw new Error(`data-usage category "${cat}" not found on the page`);
        if (state !== null) log(`data usage: ${cat} = ${state}`);
    }
    // Separate from the field fills on purpose: this click re-renders the section, and
    // batching it into the same evaluate once wedged the whole renderer.
    await pickRadio('No, I am not using remote code');
    log('remote code: No');
}

async function fillDistribution(cfg) {
    await goTab('Distribution');
    await pickRadio(cfg.visibility);
    log(`visibility: ${cfg.visibility}`);
}

// What is actually filled, and what the dashboard says still blocks submission.
async function reportStatus() {
    const st = await evalPage(() => {
        const submit = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'Submit for review');
        return {
            // "Status: Pending review  ID: abc..." - stop at the ID, not at the first space
            status: document.body.innerText.match(/Status:\s*(.+?)\s*(?:ID:|\n|$)/)?.[1]?.trim(),
            id: document.body.innerText.match(/ID:\s*([a-p]{32})/)?.[1],
            submitDisabled: submit ? (submit.disabled || submit.getAttribute('aria-disabled') === 'true') : null,
        };
    });
    // the dashboard's own validator is the only trustworthy list of blockers
    await evalPage(() => {
        const b = __all().find((e) => (e.innerText || '').includes("Why can't I submit") && e.tagName === 'BUTTON' && __vis(e));
        if (b) b.click();
    });
    await sleep(2500);
    const blockers = await evalPage(() => {
        const dlg = __all().find((e) => e.getAttribute('role') === 'dialog' && __vis(e));
        const t = dlg ? dlg.innerText.replace(/\s+/g, ' ').trim() : '';
        __dismiss();
        return t;
    });
    return { ...st, blockers: blockers || '(none reported)' };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const step = INPUT.step;
const cfg = INPUT.cfg;

if (step === 'login') {
    // openOrReuseTab reuses by the URL it is given, and the dashboard redirects straight
    // to /devconsole/<publisher-id> - so it never recognises an already-open dashboard and
    // every run would leave another tab behind. Take over an open one when there is one.
    const existing = (await listTabs()).find((t) => /chrome\.google\.com|chromewebstore\.google\.com/.test(t.url));
    if (existing) {
        await switchTab(existing.targetId);
        await dismissNativeDialog();
        // Reloading, not just looking at the tab: a stale dashboard page keeps rendering
        // long after its session has expired, so only a fresh load proves anything.
        await gotoAndWait(DEVCONSOLE, { timeout: 90 });
    } else {
        await openOrReuseTab(DEVCONSOLE, { wait: true, timeout: 90 });
    }
    await sleep(4000);
    const url = (await pageInfo()).url;
    if (!/chrome\.google\.com|chromewebstore\.google\.com/.test(url)) {
        log(`Not signed in - the dashboard redirected to ${url.slice(0, 80)}`);
        log('Sign in to the Chrome Web Store in the ego-browser window, then re-run this step.');
        emit({ signedIn: false, url });
    } else {
        const publisher = await evalPage(() => document.body.innerText.match(/Publisher:\s*(\S+)/)?.[1] ?? null);
        await recon('login');
        emit({ signedIn: true, url, publisher });
    }

} else if (step === 'newitem') {
    await attach();
    // networkidle never fires on this SPA; wait for the control, not the network
    await gotoAndWait(DEVCONSOLE, { timeout: 60 });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
        await sleep(1000);
        ready = await evalPage(() => !!__all().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Add a new item' && __vis(e)));
    }
    if (!ready) throw new Error('Add-new-item button never appeared');
    // In-page click, like every other interaction here: a plain el.click() needs no
    // compositor frame, so it works on a tab the browser is not painting.
    const clicked = await evalPage(() => {
        __dismiss();
        const btn = __all().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Add a new item' && __vis(e));
        if (!btn) return false;
        btn.click();
        return true;
    });
    if (!clicked) throw new Error('Add-new-item button not found');
    await sleep(4000);
    const open = await evalPage(() => !!__all().find((e) => e.tagName === 'INPUT' && e.type === 'file'));
    if (!open) throw new Error('Add-new-item dialog did not open');
    log('new item dialog open');
    emit({ ok: true });

} else if (step === 'upload') {
    await attach();
    let objectId = null;
    for (let i = 0; i < 30 && !objectId; i++) {
        const h = await cdp('Runtime.evaluate', {
            expression: `(() => {${DOM}\nreturn __all().find((e) => e.tagName === 'INPUT' && e.type === 'file');})()`,
        });
        objectId = h.result?.objectId ?? null;
        if (!objectId) await sleep(1000);
    }
    if (!objectId) throw new Error('no file input on the page');
    log(`uploading ${INPUT.zip}`);
    await cdp('DOM.setFileInputFiles', { objectId, files: [INPUT.zip] });
    await sleep(10000);
    const url = (await pageInfo()).url;
    if (!/\/edit/.test(url)) throw new Error(`upload did not open an edit page (url: ${url})`);
    const id = url.match(/\/([a-p]{32})\//)?.[1];
    log(`item id: ${id}`);
    emit({ id, url });

} else if (step === 'listing') {
    await attach();
    await pressKey('Escape').catch(() => {});
    await fillListing(cfg, INPUT.only);
    emit({ ok: true });

} else if (step === 'privacy') {
    await attach();
    await fillPrivacy(cfg);
    emit({ ok: true });

} else if (step === 'distribution') {
    await attach();
    await fillDistribution(cfg);
    emit({ ok: true });

} else if (step === 'save') {
    await attach();
    await saveDraft();
    emit({ ok: true });

} else if (step === 'fill') {
    // everything except item creation - for an item already open in the browser
    await attach();
    await pressKey('Escape').catch(() => {});
    await fillListing(cfg);
    await saveDraft();
    await fillPrivacy(cfg);
    await saveDraft();
    await fillDistribution(cfg);
    await saveDraft();
    emit(await reportStatus());

} else if (step === 'status') {
    await attach();
    emit(await reportStatus());

} else if (step === 'certify') {
    // The developer's compliance attestation. Only on their explicit instruction, and
    // only after confirming each statement is true of this extension.
    await attach();
    await goTab('Privacy');
    const boxes = await evalPage(() => __all()
        .filter((e) => e.tagName === 'INPUT' && e.type === 'checkbox' && __vis(e) && __near(e).startsWith('I do not'))
        .map((e) => __near(e).slice(0, 60)));
    if (boxes.length !== 3) throw new Error(`expected 3 certification boxes, found ${boxes.length}`);
    for (const b of boxes) {
        await setCheckbox(b.slice(0, 40), true);
        log(`[x] ${b}`);
    }
    await saveDraft();
    emit({ ok: true, boxes });

} else if (step === 'submit') {
    await attach();
    const before = await reportStatus();
    // the button stays enabled after a successful submission, so status is the guard
    if (before.status && !/^Draft/i.test(before.status)) {
        throw new Error(`item is already "${before.status}" - nothing to submit`);
    }
    if (before.submitDisabled) throw new Error(`cannot submit - blockers: ${before.blockers}`);
    const opened = await evalPage(() => {
        const btn = __all().find((e) => e.tagName === 'BUTTON' && (e.innerText || '').trim() === 'Submit for review');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
    });
    if (!opened) throw new Error('Submit for review button not clickable');
    await sleep(6000);
    // that button only OPENS a confirmation dialog; the dialog's own button submits
    const confirmed = await evalPage(() => {
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
        status = (await reportStatus()).status;
        if (status && !/^Draft/i.test(status)) break;
        log(`   waiting for status to flip (${status})`);
    }
    await recon('submitted');
    // The header can lag the submission by minutes. Re-read with `status` before
    // believing this and never re-submit on it - that is how duplicates happen.
    if (/^Draft/i.test(status || '')) {
        throw new Error('still Draft after 3 minutes - re-run `status` before assuming it failed');
    }
    emit({ status });

} else {
    throw new Error(`unknown step: ${step}`);
}
