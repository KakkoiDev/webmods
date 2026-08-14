// Drives the Chrome Web Store Developer Dashboard in a real browser, for the parts the
// CWS API cannot do: creating the item, the store-listing copy, screenshots, the privacy
// answers, and visibility.
//
// The browser is ego-browser: this script never launches or attaches to one. All browser
// work happens in a named task space, whose tabs stay alive between runs - that is what
// lets `newitem` hand an open item to `upload` and `fill`. Sign in once, in that window:
//
//   node .../dashboard.mjs login                       # open the dashboard, report who is signed in
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
// The page-driving half of this tool lives in dashboard-page.js, because ego-browser takes
// browser work as source text rather than as calls on a Page object.
//
// Everything the dashboard taught us the hard way is in docs/CHROME-WEB-STORE-AUTOMATION.md.
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEVCONSOLE = 'https://chrome.google.com/webstore/devconsole';
export const EGO_BIN = process.env.EGO_BROWSER_BIN || 'ego-browser';
// One named task space for every step. Reusing the name is what keeps the signed-in
// session and the open item between separate runs of this script.
export const EGO_TASK = 'chrome web store';
const OUT = join(homedir(), '.cache', 'chrome-web-store', 'recon');
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Running a step
//
// ego-browser holds its output until the process exits, so progress cannot come back over
// a pipe - a `fill` would print its whole log at the end, after the minutes in which it is
// the only sign of life. Progress is therefore appended to a file the page script writes
// and this side tails, and the step's return value is written to a second file.
// ---------------------------------------------------------------------------
export function runStep(step, input = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cws-'));
    const progress = join(dir, 'progress.log');
    const resultPath = join(dir, 'result.json');
    const page = readFileSync(join(here, 'dashboard-page.js'), 'utf8');
    const script = `const INPUT = ${JSON.stringify({
        ...input, step, task: EGO_TASK, out: OUT, progress, result: resultPath,
    })};\n${page}`;

    return new Promise((resolve_, reject) => {
        const child = spawn(EGO_BIN, ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
        child.on('error', (e) => reject(new Error(
            e.code === 'ENOENT'
                ? `${EGO_BIN} not found on PATH. This tool drives ego-browser (ego lite);`
                  + ` install it, or set EGO_BROWSER_BIN.`
                : `${EGO_BIN} failed to start: ${e.message}`,
        )));

        let shown = 0;
        const tail = () => {
            if (!existsSync(progress)) return;
            const size = statSync(progress).size;
            if (size <= shown) return;
            const fd = openSync(progress, 'r');
            const buf = Buffer.alloc(size - shown);
            readSync(fd, buf, 0, buf.length, shown);
            closeSync(fd);
            shown = size;
            process.stderr.write(buf.toString());
        };
        const timer = setInterval(tail, 250);

        child.on('close', (code) => {
            clearInterval(timer);
            tail();
            let result = null, parsed = false;
            if (existsSync(resultPath)) {
                try { result = JSON.parse(readFileSync(resultPath, 'utf8')); parsed = true; } catch { /* fall through */ }
            }
            rmSync(dir, { recursive: true, force: true });
            if (code !== 0) return reject(Object.assign(new Error(`step "${step}" failed`), { exitCode: code, quiet: true }));
            if (!parsed) return reject(new Error(`step "${step}" returned no result`));
            resolve_(result);
        });
        child.stdin.end(script);
    });
}

// ---------------------------------------------------------------------------
// Listing config, read from the extension's own store-listing.md so the repo stays the
// source of truth and nothing about a specific extension is hardcoded here.
// ---------------------------------------------------------------------------

// The dashboard's data-collection types. Every one is set explicitly from store-listing.md,
// so a declaration is the same whether the item is new or is being corrected - leaving a box
// alone would silently keep a claim the listing no longer makes.
export const DATA_CATEGORIES = [
    'Personally identifiable information', 'Health information', 'Financial and payment information',
    'Authentication information', 'Personal communications', 'Location', 'Web history',
    'User activity', 'Website content',
];

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
        icon: resolve(extDir, 'store-icon-128.png'),
        screenshots: [1, 2, 3, 4, 5].map((n) => resolve(extDir, `store-screenshot-${n}.png`)).filter(existsSync),
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
// CLI. Importing this module must never drive a browser - it once launched one at import
// time, spawning a second Chrome that tripped Google's automation block.
// ---------------------------------------------------------------------------
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
    const step = process.argv[2] || 'status';
    const arg = process.argv[3];
    const extDir = arg && arg.startsWith('extensions/') ? arg : 'extensions/slack-ai-translate';

    const withCfg = (extra = {}) => ({ cfg: readListing(extDir), dataCategories: DATA_CATEGORIES, ...extra });

    try {
        if (step === 'login') {
            const r = await runStep('login');
            if (r.signedIn) {
                console.error(`signed in - publisher: ${r.publisher ?? '(unknown)'}`);
            } else {
                process.exit(1);
            }

        } else if (step === 'newitem' || step === 'save') {
            await runStep(step);

        } else if (step === 'upload') {
            const zip = resolve(arg && arg.endsWith('.zip') ? arg : `${extDir}-cws.zip`);
            if (!existsSync(zip)) throw new Error(`zip not found: ${zip} (run make-zip.mjs first)`);
            await runStep('upload', { zip });

        } else if (step === 'listing') {
            await runStep('listing', withCfg({ only: process.argv[4] ?? null }));

        } else if (step === 'privacy' || step === 'distribution') {
            await runStep(step, withCfg());

        } else if (step === 'fill') {
            console.error(JSON.stringify(await runStep('fill', withCfg()), null, 1));

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
            console.error(JSON.stringify(await runStep('status'), null, 1));

        } else if (step === 'certify') {
            await runStep('certify');

        } else if (step === 'submit') {
            const r = await runStep('submit');
            console.error(`status: ${r.status}`);

        } else {
            console.error(`unknown step: ${step}`);
            console.error('steps: login | all | fill | newitem | upload | listing | privacy | distribution | save | status | certify | submit');
            process.exit(1);
        }
    } catch (e) {
        // A failed step has already printed the browser side's own error; don't repeat it.
        if (!e.quiet) console.error(e.message);
        process.exit(e.exitCode || 1);
    }
}
