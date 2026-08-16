// ==UserScript==
// @name         Tuta Inbox Janitor
// @namespace    http://tampermonkey.net/
// @icon         https://app.tuta.com/images/logo-favicon-192.png
// @version      2026.08.15
// @description  Scan your Tuta mailbox, group it by sender, and clean it up with shareable rules - dry-run first, move to Trash/Spam/folders, never permanent delete
// @author       KakkoiDev
// @match        https://app.tuta.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

// Tuta is end-to-end encrypted, so there is no server-side API to query - but the web client keeps its
// whole DECRYPTED model on `window.tutao`. This script drives that model directly instead of scraping
// the virtualised mail list:
//   tutao.locator.mailboxModel.getMailboxDetails()      -> mailbox + mail group id
//   tutao.locator.mailModel.getMailSetsForGroup(gid)    -> FolderSystem (getIndentedList() -> MailFolder[])
//   entityClient.loadAll(MailSetEntry, folder.entries)  -> one entry per mail in that folder
//   entityClient.loadMultiple(Mail, listId, elementIds) -> decrypted Mail metadata (sender/subject/date)
//   mailModel.moveMails(mailIds, targetFolder, 0)       -> move (0 = just these mails, 1 = whole conversation)
// Type refs are `{app, typeId}`; we resolve the ids by NAME from tutao.locator.clientModelInfo so a
// server model bump doesn't silently break us.
//
// Safety rules baked in, by design:
//   - nothing is ever permanently deleted (mailModel.finallyDeleteMails is never called)
//   - every run is a dry run first; applying needs a second, explicit confirm click
//   - `keep` rules win over every action rule, so you can whitelist senders you must never lose

(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (window.__TUTA_JANITOR__) return;
    window.__TUTA_JANITOR__ = true;

    const STORAGE_KEY = 'tutaJanitor.config.v1';
    const CHUNK = 200;          // mails per loadMultiple call
    const MOVE_CHUNK = 100;     // mails per move call
    const INDEX_PAGE = 1000;    // MailSetEntry rows per loadRange page

    const FOLDER_TYPE = { CUSTOM: '0', INBOX: '1', SENT: '2', TRASH: '3', ARCHIVE: '4', SPAM: '5', DRAFTS: '6' };
    const SYSTEM_NAME = {
        [FOLDER_TYPE.INBOX]: 'Inbox', [FOLDER_TYPE.SENT]: 'Sent', [FOLDER_TYPE.TRASH]: 'Trash',
        [FOLDER_TYPE.ARCHIVE]: 'Archive', [FOLDER_TYPE.SPAM]: 'Spam', [FOLDER_TYPE.DRAFTS]: 'Drafts',
    };

    // ---------------------------------------------------------------- config

    const DEFAULT_CONFIG = {
        version: 1,
        // Folders scanned by default (by display name).
        scanFolders: ['Inbox'],
        // Rules run top to bottom; `keep` rules are evaluated first and protect a mail from everything.
        // { id, name, enabled, kind: 'keep'|'action', when: {...}, action: {target}, from: ['Inbox'] | ['*'] }
        // when: { field: 'from'|'domain'|'subject'|'senderName', op: 'is'|'contains'|'regex', value: '...' }
        // action.target: 'Trash' | 'Spam' | 'Archive' | any custom folder name
        rules: [],
    };

    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return structuredClone(DEFAULT_CONFIG);
            const parsed = JSON.parse(raw);
            return Object.assign(structuredClone(DEFAULT_CONFIG), parsed);
        } catch (e) {
            console.warn('[janitor] bad stored config, using defaults', e);
            return structuredClone(DEFAULT_CONFIG);
        }
    }

    function saveConfig(cfg) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg, null, 2));
    }

    let config = loadConfig();

    // ------------------------------------------------------------ tuta model

    const state = {
        folders: [],      // [{name, type, id, entriesListId, folder}]
        mails: [],        // scanned: [{id, folder, from, name, subject, date, unread, unsub}]
        scannedAt: null,
        scanning: false,
        stale: false,
        plan: null,       // last dry run
        confirmArmed: false,
    };

    const locator = () => window.tutao && window.tutao.locator;

    function typeRef(name) {
        const models = locator().clientModelInfo.typeModels;
        for (const [app, types] of Object.entries(models)) {
            for (const [typeId, model] of Object.entries(types)) {
                if (model && model.name === name) return { app, typeId: Number(typeId), phantom: null };
            }
        }
        throw new Error('type not found in client model: ' + name);
    }

    async function loadFolders() {
        const L = locator();
        const details = await L.mailboxModel.getMailboxDetails();
        const out = [];
        for (const d of details) {
            // `mailGroup._id` comes back as an [listId, elementId] tuple with a null list part; the
            // group id we need is the element part (same value as mailGroupInfo.group).
            const groupId = Array.isArray(d.mailGroup._id) ? d.mailGroup._id[1] : d.mailGroup._id;
            const system = (await L.mailModel.getMailSetsForGroup(groupId)).folders;
            for (const { folder, mailSet } of system.getIndentedList()) {
                const f = mailSet || folder;
                out.push({
                    name: f.name || SYSTEM_NAME[f.folderType] || '(unnamed)',
                    type: f.folderType,
                    id: f._id,
                    entriesListId: f.entries,
                    folder: f,
                });
            }
        }
        state.folders = out;
        return out;
    }

    function folderByName(name) {
        return state.folders.find((f) => f.name.toLowerCase() === String(name).toLowerCase());
    }

    /** Move targets a rule may point at - never Drafts/Sent, never a permanent delete. */
    function moveTargets() {
        return state.folders.filter((f) => f.type !== FOLDER_TYPE.DRAFTS && f.type !== FOLDER_TYPE.SENT);
    }

    async function scanFolders(names, onProgress) {
        const L = locator();
        const MSE = typeRef('MailSetEntry');
        const MAIL = typeRef('Mail');
        const picked = names.map(folderByName).filter(Boolean);

        // Pass 1: one MailSetEntry per mail (cheap, tells us which mail list each mail lives in).
        // Paged with loadRange rather than loadAll: loadAll is a single opaque await that can sit there
        // for a minute on a big mailbox with nothing to show, whereas paging lets us report a running
        // count. Passing '' as the start id returns the list from the beginning.
        const perFolder = [];
        let indexed = 0;
        for (const f of picked) {
            const entries = [];
            let start = '';
            for (;;) {
                if (!state.scanning) return [];
                const page = await L.entityClient.loadRange(MSE, f.entriesListId, start, INDEX_PAGE, false);
                entries.push(...page);
                indexed += page.length;
                onProgress({ phase: 'index', folder: f.name, indexed });
                if (page.length < INDEX_PAGE) break;
                start = page[page.length - 1]._id[1];
            }
            perFolder.push({ folder: f, entries });
        }
        const total = perFolder.reduce((n, p) => n + p.entries.length, 0);

        // Pass 2: the mails themselves, batched per mail list.
        const mails = [];
        let done = 0;
        for (const { folder, entries } of perFolder) {
            const byList = new Map();
            for (const e of entries) {
                if (!byList.has(e.mail[0])) byList.set(e.mail[0], []);
                byList.get(e.mail[0]).push(e.mail[1]);
            }
            for (const [listId, ids] of byList) {
                for (let i = 0; i < ids.length; i += CHUNK) {
                    if (!state.scanning) return mails; // user pressed Stop
                    let batch = [];
                    try {
                        batch = await L.entityClient.loadMultiple(MAIL, listId, ids.slice(i, i + CHUNK));
                    } catch (err) {
                        console.warn('[janitor] batch failed, skipping', err);
                    }
                    for (const m of batch) {
                        mails.push({
                            id: m._id,
                            folder: folder.name,
                            from: ((m.sender && m.sender.address) || '').toLowerCase(),
                            name: (m.sender && m.sender.name) || '',
                            subject: m.subject || '',
                            date: Number(m.receivedDate) || 0,
                            unread: m.unread === '1' || m.unread === true,
                            unsub: !!m.listUnsubscribe,
                        });
                    }
                    done += ids.slice(i, i + CHUNK).length;
                    onProgress({ phase: 'mails', folder: folder.name, done, total });
                }
            }
        }
        return mails;
    }

    function groupBySender(mails) {
        const map = new Map();
        for (const m of mails) {
            let r = map.get(m.from);
            if (!r) {
                r = { from: m.from, domain: m.from.split('@')[1] || '', names: new Set(), n: 0, unread: 0, unsub: 0, first: Infinity, last: 0, subjects: [] };
                map.set(m.from, r);
            }
            r.n++;
            if (m.name) r.names.add(m.name);
            if (m.unread) r.unread++;
            if (m.unsub) r.unsub++;
            if (m.date && m.date < r.first) r.first = m.date;
            if (m.date > r.last) r.last = m.date;
            if (r.subjects.length < 3) r.subjects.push(m.subject);
        }
        return [...map.values()].sort((a, b) => b.n - a.n);
    }

    // ------------------------------------------------------------ rule engine

    function matches(rule, mail) {
        const w = rule.when || {};
        const hay = {
            from: mail.from,
            domain: mail.from.split('@')[1] || '',
            subject: mail.subject,
            senderName: mail.name,
        }[w.field];
        if (hay == null) return false;
        const needle = String(w.value ?? '');
        if (w.op === 'regex') {
            try { return new RegExp(needle, 'i').test(hay); } catch { return false; }
        }
        const a = hay.toLowerCase(), b = needle.toLowerCase();
        return w.op === 'is' ? a === b : a.includes(b);
    }

    function inScope(rule, mail) {
        const scope = rule.from && rule.from.length ? rule.from : ['*'];
        return scope.includes('*') || scope.some((n) => n.toLowerCase() === mail.folder.toLowerCase());
    }

    /** Returns {byRule, byTarget, kept, total} - what a run WOULD do. Never mutates anything. */
    function dryRun(mails, rules) {
        const enabled = rules.filter((r) => r.enabled !== false);
        const keeps = enabled.filter((r) => r.kind === 'keep');
        const actions = enabled.filter((r) => r.kind !== 'keep');
        const byRule = new Map(actions.map((r) => [r.id, { rule: r, mails: [] }]));
        const byTarget = new Map();
        let kept = 0;

        for (const mail of mails) {
            if (keeps.some((r) => inScope(r, mail) && matches(r, mail))) { kept++; continue; }
            const hit = actions.find((r) => inScope(r, mail) && matches(r, mail));
            if (!hit) continue;
            const target = hit.action && hit.action.target;
            if (!target || target.toLowerCase() === mail.folder.toLowerCase()) continue; // already there
            byRule.get(hit.id).mails.push(mail);
            if (!byTarget.has(target)) byTarget.set(target, []);
            byTarget.get(target).push(mail);
        }
        return { byRule: [...byRule.values()], byTarget, kept, total: mails.length };
    }

    async function applyPlan(plan, onProgress) {
        const L = locator();
        const results = [];
        let moved = 0;
        const totalToMove = [...plan.byTarget.values()].reduce((n, l) => n + l.length, 0);

        for (const [targetName, mails] of plan.byTarget) {
            const target = folderByName(targetName);
            if (!target) { results.push({ target: targetName, moved: 0, error: 'no such folder' }); continue; }
            if (target.type === FOLDER_TYPE.DRAFTS || target.type === FOLDER_TYPE.SENT) {
                results.push({ target: targetName, moved: 0, error: 'refusing to move into ' + targetName });
                continue;
            }
            let ok = 0;
            for (let i = 0; i < mails.length; i += MOVE_CHUNK) {
                const slice = mails.slice(i, i + MOVE_CHUNK);
                try {
                    // moveMode 0 = move exactly these mails (1 would drag the whole conversation along).
                    await L.mailModel.moveMails(slice.map((m) => m.id), target.folder, 0);
                    ok += slice.length;
                } catch (err) {
                    console.error('[janitor] move failed', err);
                    results.push({ target: targetName, moved: ok, error: String(err) });
                    break;
                }
                moved += slice.length;
                onProgress({ done: moved, total: totalToMove, target: targetName });
            }
            results.push({ target: targetName, moved: ok });
        }
        state.stale = true;
        return results;
    }

    // ------------------------------------------------------------------- UI

    const fmtDate = (t) => (t && isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '-');
    const fmtN = (n) => Number(n).toLocaleString();
    const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const host = document.createElement('div');
    host.id = 'tuta-janitor-host';
    const shadow = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);

    shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  /* Fallback launcher - only shown if the sidebar row could not be mounted. */
  .fab {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
    width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
    background: #850122; color: #fff; font-size: 20px; line-height: 44px; text-align: center;
    box-shadow: 0 2px 10px rgba(0,0,0,.45); display: none;
  }
  .fab.show { display: block; }
  .fab:hover { filter: brightness(1.15); }
  .panel {
    /* Sits in the content area, clear of the 300px sidebar and the 72px top bar. */
    position: fixed; left: 308px; top: 78px; z-index: 2147483000;
    width: min(920px, calc(100vw - 324px)); height: min(680px, calc(100vh - 96px));
    display: none; flex-direction: column; overflow: hidden;
    background: #1b1718; color: #eee; border: 1px solid #3a3234; border-radius: 10px;
    box-shadow: 0 8px 40px rgba(0,0,0,.6); font-size: 13px;
  }
  .panel.open { display: flex; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #3a3234; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .tabs { display: flex; gap: 4px; margin-left: auto; }
  .tabs button, .btn {
    background: #2a2426; color: #eee; border: 1px solid #453d3f; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; font-size: 12px;
  }
  .tabs button.active { background: #850122; border-color: #850122; }
  .btn:hover, .tabs button:hover { filter: brightness(1.2); }
  .btn.primary { background: #850122; border-color: #850122; }
  .btn.danger { background: #a3243d; border-color: #a3243d; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .body { flex: 1; overflow: auto; padding: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .muted { color: #9b9092; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #2e2829; vertical-align: top; }
  th { position: sticky; top: -12px; background: #1b1718; z-index: 1; font-weight: 600; color: #c9bfc1; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  input[type=text], textarea, select {
    background: #241f20; color: #eee; border: 1px solid #453d3f; border-radius: 6px; padding: 5px 7px; font-size: 12px;
  }
  textarea { width: 100%; height: 320px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { height: 6px; background: #2e2829; border-radius: 3px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #850122; width: 0%; }
  .pill { background: #2a2426; border-radius: 10px; padding: 1px 7px; font-size: 11px; }
  .subj { color: #8d8385; font-size: 11px; }
  label.chk { display: inline-flex; gap: 4px; align-items: center; margin-right: 8px; }
  .warn { color: #ffb4a2; }
  .ok { color: #9ede9e; }
</style>
<button class="fab" title="Tuta Inbox Janitor">🧹</button>
<div class="panel">
  <header>
    <h1>Tuta Inbox Janitor</h1>
    <span class="muted" id="status"></span>
    <div class="tabs">
      <button data-tab="scan" class="active">Scan</button>
      <button data-tab="rules">Rules</button>
      <button data-tab="run">Run</button>
      <button data-tab="close">✕</button>
    </div>
  </header>
  <div class="body" id="body"></div>
</div>`;

    const $ = (sel) => shadow.querySelector(sel);
    const panel = $('.panel');
    const body = $('#body');
    const statusEl = $('#status');
    let tab = 'scan';
    let senderFilter = '';
    const pending = new Map(); // sender address -> target folder name (staged, not yet a rule)

    function isOpen() { return panel.classList.contains('open'); }

    function togglePanel(force) {
        const open = force === undefined ? !isOpen() : force;
        panel.classList.toggle('open', open);
        if (open) render();
        paintNavRow();
    }

    $('.fab').addEventListener('click', () => togglePanel());
    shadow.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.tab === 'close') { togglePanel(false); return; }
        tab = b.dataset.tab;
        shadow.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
        render();
    }));

    function setStatus(text) { statusEl.textContent = text; }

    function render() {
        if (tab === 'scan') renderScan();
        else if (tab === 'rules') renderRules();
        else renderRun();
    }

    // ---- scan tab

    function renderScan() {
        const senders = state.mails.length ? groupBySender(state.mails) : [];
        const targets = moveTargets();
        const filtered = senderFilter
            ? senders.filter((s) => (s.from + ' ' + [...s.names].join(' ')).toLowerCase().includes(senderFilter.toLowerCase()))
            : senders;

        body.innerHTML = `
      <div class="row">
        <strong>Folders to scan:</strong>
        ${state.folders.map((f) => `<label class="chk"><input type="checkbox" data-folder="${esc(f.name)}"
            ${config.scanFolders.includes(f.name) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}
      </div>
      <div class="row">
        <button class="btn primary" id="scanBtn" ${state.scanning ? 'disabled' : ''}>Scan</button>
        <button class="btn" id="stopBtn" ${state.scanning ? '' : 'disabled'}>Stop</button>
        <span class="muted" id="scanInfo">${state.scannedAt ? `${fmtN(state.mails.length)} emails from ${fmtN(senders.length)} senders - scanned ${new Date(state.scannedAt).toLocaleTimeString()}` : 'not scanned yet'}</span>
      </div>
      <div class="bar" id="bar"><i></i></div>
      ${senders.length ? `
      <div class="row" style="margin-top:12px">
        <input type="text" id="filter" placeholder="filter senders" value="${esc(senderFilter)}" style="width:220px">
        <span class="muted">Pick a target per sender, then</span>
        <button class="btn primary" id="mkRules">Create rules from picks (<span id="pcount">${pending.size}</span>)</button>
        <button class="btn" id="copyMd">Copy report (markdown)</button>
        <button class="btn" id="copyJson">Copy report (JSON)</button>
      </div>
      <table>
        <thead><tr>
          <th>Sender</th><th class="num">Mails</th><th class="num">Unread</th><th class="num">Unsub</th>
          <th>First</th><th>Last</th><th>Move to</th>
        </tr></thead>
        <tbody>
          ${filtered.slice(0, 400).map((s) => `
            <tr>
              <td>${esc(s.from)}<div class="subj">${esc([...s.names][0] || '')}${s.subjects[0] ? ' - ' + esc(s.subjects[0].slice(0, 60)) : ''}</div></td>
              <td class="num">${s.n}</td><td class="num">${s.unread}</td>
              <td class="num">${s.unsub ? '<span class="pill">yes</span>' : ''}</td>
              <td>${fmtDate(s.first)}</td><td>${fmtDate(s.last)}</td>
              <td><select data-sender="${esc(s.from)}">
                <option value="">- keep -</option>
                ${targets.map((t) => `<option value="${esc(t.name)}" ${pending.get(s.from) === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select></td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${filtered.length > 400 ? `<p class="muted">showing top 400 of ${filtered.length} senders - use the filter to reach the rest</p>` : ''}
      ` : '<p class="muted">Scan a folder to see who is filling it up.</p>'}`;

        shadow.querySelectorAll('[data-folder]').forEach((cb) => cb.addEventListener('change', () => {
            const names = [...shadow.querySelectorAll('[data-folder]')].filter((x) => x.checked).map((x) => x.dataset.folder);
            config.scanFolders = names;
            saveConfig(config);
        }));
        $('#scanBtn').addEventListener('click', doScan);
        $('#stopBtn').addEventListener('click', () => { state.scanning = false; });
        const filterEl = $('#filter');
        if (filterEl) {
            filterEl.addEventListener('input', debounce(() => { senderFilter = filterEl.value; renderScan(); }, 250));
        }
        shadow.querySelectorAll('[data-sender]').forEach((sel) => sel.addEventListener('change', () => {
            if (sel.value) pending.set(sel.dataset.sender, sel.value);
            else pending.delete(sel.dataset.sender);
            const c = $('#pcount'); if (c) c.textContent = pending.size;
        }));
        const mk = $('#mkRules');
        if (mk) mk.addEventListener('click', createRulesFromPicks);
        const md = $('#copyMd'); if (md) md.addEventListener('click', () => copy(reportMarkdown(senders)));
        const js = $('#copyJson'); if (js) js.addEventListener('click', () => copy(JSON.stringify(senders.map(serialiseSender), null, 2)));
    }

    const serialiseSender = (s) => ({
        from: s.from, domain: s.domain, names: [...s.names], mails: s.n, unread: s.unread,
        listUnsubscribe: s.unsub, first: fmtDate(s.first), last: fmtDate(s.last), sampleSubjects: s.subjects,
    });

    function reportMarkdown(senders) {
        const lines = [`# Tuta mailbox report`, ``, `Folders: ${config.scanFolders.join(', ')} - ${state.mails.length} mails, ${senders.length} senders`, ``,
            `| Sender | Mails | Unread | Unsub | First | Last |`, `|---|---:|---:|---|---|---|`];
        for (const s of senders) {
            lines.push(`| ${s.from} | ${s.n} | ${s.unread} | ${s.unsub ? 'yes' : ''} | ${fmtDate(s.first)} | ${fmtDate(s.last)} |`);
        }
        return lines.join('\n');
    }

    async function doScan() {
        if (state.scanning) return;
        state.scanning = true;
        state.plan = null;
        state.confirmArmed = false;
        renderScan();
        // Re-query on every tick instead of capturing the nodes: switching tabs mid-scan re-renders the
        // body, and a captured reference would go on updating a detached node - progress would appear
        // frozen at "not scanned yet" for the rest of the run.
        const bar = () => $('#bar > i');
        const info = () => $('#scanInfo');
        let mailsStartedAt = 0;
        try {
            const mails = await scanFolders(config.scanFolders, (p) => {
                if (p.phase === 'index') {
                    // Total is unknown until every folder is indexed, so report the running count.
                    const b = bar(), i = info();
                    if (b) b.style.width = '0%';
                    if (i) i.textContent = `Indexing ${p.folder} - ${fmtN(p.indexed)} emails found...`;
                    setStatus(`indexing ${fmtN(p.indexed)}`);
                    return;
                }
                if (!mailsStartedAt) mailsStartedAt = Date.now();
                const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
                const b = bar(), i = info();
                if (b) b.style.width = pct + '%';
                // Rate is measured from the start of THIS phase - including the indexing time would
                // make the first estimates wildly pessimistic.
                const elapsed = (Date.now() - mailsStartedAt) / 1000;
                const rate = elapsed > 1 ? p.done / elapsed : 0;
                const eta = rate > 0 ? Math.round((p.total - p.done) / rate) : 0;
                if (i) {
                    i.textContent = `Scanning ${p.folder} - ${fmtN(p.done)} of ${fmtN(p.total)} emails (${pct}%)`
                        + (eta > 2 ? ` - about ${fmtSecs(eta)} left` : '');
                }
                setStatus(`${fmtN(p.done)} / ${fmtN(p.total)}`);
            });
            state.mails = mails;
            state.scannedAt = Date.now();
            state.stale = false;
        } catch (err) {
            console.error('[janitor] scan failed', err);
            if (info) info.textContent = 'scan failed: ' + err;
        } finally {
            state.scanning = false;
            setStatus('');
            renderScan();
        }
    }

    function createRulesFromPicks() {
        for (const [sender, target] of pending) {
            const id = 'r' + Math.random().toString(36).slice(2, 9);
            config.rules.push({
                id, name: `${sender} -> ${target}`, enabled: true, kind: 'action',
                when: { field: 'from', op: 'is', value: sender },
                action: { target },
                from: config.scanFolders.slice(),
            });
        }
        pending.clear();
        saveConfig(config);
        tab = 'rules';
        shadow.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'rules'));
        render();
    }

    // ---- rules tab

    function renderRules() {
        body.innerHTML = `
      <div class="row">
        <button class="btn primary" id="save">Save rules</button>
        <button class="btn" id="copyCfg">Copy config (share)</button>
        <button class="btn" id="pasteCfg">Paste config</button>
        <button class="btn danger" id="reset">Reset</button>
        <span class="muted">${config.rules.length} rule(s) - <code>keep</code> rules always win</span>
      </div>
      <textarea id="cfg" spellcheck="false">${esc(JSON.stringify(config, null, 2))}</textarea>
      <p class="muted">
        rule: <code>{ id, name, enabled, kind: "action"|"keep", when: { field: "from"|"domain"|"subject"|"senderName",
        op: "is"|"contains"|"regex", value }, action: { target: "Trash"|"Spam"|"Archive"|"&lt;folder&gt;" }, from: ["Inbox"] }</code><br>
        <code>from</code> limits which folders a rule applies to (<code>["*"]</code> = any). Nothing is ever deleted permanently.
      </p>
      <div id="cfgMsg"></div>`;

        $('#save').addEventListener('click', () => {
            try {
                const next = JSON.parse($('#cfg').value);
                if (!Array.isArray(next.rules)) throw new Error('rules must be an array');
                config = Object.assign(structuredClone(DEFAULT_CONFIG), next);
                saveConfig(config);
                state.plan = null;
                $('#cfgMsg').innerHTML = '<span class="ok">saved</span>';
            } catch (err) {
                $('#cfgMsg').innerHTML = '<span class="warn">' + esc(String(err)) + '</span>';
            }
        });
        $('#copyCfg').addEventListener('click', () => copy(JSON.stringify(config, null, 2)));
        $('#pasteCfg').addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                $('#cfg').value = text;
                $('#cfgMsg').innerHTML = '<span class="muted">pasted - press Save rules to apply</span>';
            } catch (err) {
                $('#cfgMsg').innerHTML = '<span class="warn">clipboard read blocked - paste into the box by hand</span>';
            }
        });
        $('#reset').addEventListener('click', () => {
            config = structuredClone(DEFAULT_CONFIG);
            saveConfig(config);
            renderRules();
        });
    }

    // ---- run tab

    function renderRun() {
        const plan = state.plan;
        body.innerHTML = `
      <div class="row">
        <button class="btn primary" id="dry" ${state.mails.length ? '' : 'disabled'}>Dry run</button>
        <button class="btn danger" id="apply" ${plan && plan.byTarget.size ? '' : 'disabled'}>
          ${state.confirmArmed ? 'Click again to confirm' : 'Apply moves'}</button>
        <span class="muted">${state.mails.length ? `${state.mails.length} scanned mails` : 'scan first'}${state.stale ? ' - stale, rescan recommended' : ''}</span>
      </div>
      <div class="bar" id="rbar"><i></i></div>
      <div id="planOut">${plan ? planHtml(plan) : '<p class="muted">A dry run shows exactly what would move. Nothing happens until you press Apply and confirm.</p>'}</div>`;

        $('#dry').addEventListener('click', () => {
            state.plan = dryRun(state.mails, config.rules);
            state.confirmArmed = false;
            renderRun();
            paintNavRow();
        });
        $('#apply').addEventListener('click', async () => {
            if (!state.plan) return;
            if (!state.confirmArmed) { state.confirmArmed = true; renderRun(); return; }
            state.confirmArmed = false;
            const bar = $('#rbar > i');
            const out = $('#planOut');
            const results = await applyPlan(state.plan, ({ done, total, target }) => {
                if (bar && total) bar.style.width = Math.round((done / total) * 100) + '%';
                setStatus(`moving ${done}/${total} -> ${target}`);
            });
            setStatus('');
            state.plan = null;
            paintNavRow();
            out.innerHTML = '<h3>Done</h3><ul>' + results.map((r) =>
                `<li>${esc(r.target)}: moved ${r.moved}${r.error ? ` <span class="warn">(${esc(r.error)})</span>` : ''}</li>`).join('') +
                '</ul><p class="muted">Everything moved is recoverable from the target folder.</p>';
        });
    }

    function planHtml(plan) {
        const total = [...plan.byTarget.values()].reduce((n, l) => n + l.length, 0);
        if (!total) return '<p class="muted">No mail matches the current rules.</p>';
        let html = `<p><strong>${total}</strong> mails would move (${plan.kept} protected by keep rules, ${plan.total} scanned).</p>`;
        html += '<table><thead><tr><th>Target</th><th class="num">Mails</th><th>Top senders</th></tr></thead><tbody>';
        for (const [target, mails] of plan.byTarget) {
            const top = groupBySender(mails).slice(0, 5).map((s) => `${esc(s.from)} (${s.n})`).join(', ');
            html += `<tr><td>${esc(target)}</td><td class="num">${mails.length}</td><td class="subj">${top}</td></tr>`;
        }
        html += '</tbody></table><h3>Per rule</h3><table><thead><tr><th>Rule</th><th class="num">Matches</th></tr></thead><tbody>';
        for (const { rule, mails } of plan.byRule) {
            html += `<tr><td>${esc(rule.name || rule.id)}</td><td class="num">${mails.length}</td></tr>`;
        }
        return html + '</tbody></table>';
    }

    // ---- helpers

    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

    function copy(text) {
        navigator.clipboard.writeText(text).then(() => setStatus('copied'), () => setStatus('copy failed'));
        setTimeout(() => setStatus(''), 1500);
    }

    // ------------------------------------------------- sidebar "Cleaner" entry

    // The sidebar is mithril-rendered and gets rebuilt on every redraw (new mail, folder switch, counter
    // tick), so the row is re-mounted by an observer rather than inserted once. Anchored on the stable
    // `data-testid`, and it copies its className + resting colours off the real Inbox row so it follows
    // whatever theme is active instead of hardcoding Tuta's palette.
    const NAV_ID = 'janitor-nav-row';
    const BROOM = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
        + '<path d="M20.71 3.29a1 1 0 0 0-1.42 0L13 9.59 14.41 11l6.3-6.29a1 1 0 0 0 0-1.42Z"/>'
        + '<path d="M11.59 11 3.3 19.29a1 1 0 0 0 0 1.42l1 1a1 1 0 0 0 1.41 0L14 13.41Z"/>'
        + '<path d="M18 13.2l1.2 2.6 2.8 1.2-2.8 1.2L18 20.8l-1.2-2.6L14 17l2.8-1.2Z"/></svg>';

    function inboxRow() {
        const a = document.querySelector('a[data-testid="btn:folder:Inbox"]');
        return a ? a.closest('.folder-row') : null;
    }

    /**
     * Colours must come from a RESTING row, not from the Inbox row we anchor to - Tuta marks the
     * selected folder with `aria-current=""` and an accent colour, so copying Inbox would leave our
     * row looking permanently selected.
     */
    function restingRow() {
        const rows = [...document.querySelectorAll('.folder-row')];
        return rows.find((r) => {
            const a = r.querySelector('a.nav-button');
            return a && a.getAttribute('aria-current') === null && r.id !== NAV_ID;
        }) || null;
    }

    function buildNavRow(sample) {
        const colourSrc = restingRow() || sample;
        const sampleAnchor = sample.querySelector('a.nav-button');
        const colourAnchor = colourSrc.querySelector('a.nav-button');
        const colourIcon = colourSrc.querySelector('span.icon');
        const fg = colourAnchor ? getComputedStyle(colourAnchor).color : 'inherit';
        const fill = colourIcon ? getComputedStyle(colourIcon).fill : fg;

        const row = document.createElement('div');
        row.id = NAV_ID;
        row.title = 'Inbox Janitor';
        row.className = sample.className;

        const indent = document.createElement('div');
        indent.style.marginLeft = '0px';

        const iconBtn = document.createElement('button');
        iconBtn.className = 'flex items-center justify-end';
        iconBtn.style.cssText = 'left:0;width:40px;height:44px;padding-left:8px;padding-right:8px;z-index:3';
        const iconSpan = document.createElement('span');
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.className = 'icon icon-24';
        iconSpan.style.fill = fill;
        iconSpan.innerHTML = BROOM;
        iconBtn.appendChild(iconSpan);

        const link = document.createElement('a');
        link.setAttribute('role', 'button');
        link.title = 'Inbox Janitor';
        link.dataset.testid = 'btn:folder:Cleaner';
        link.className = sampleAnchor ? sampleAnchor.className : 'nav-button';
        link.style.color = fg;
        const label = document.createElement('span');
        label.className = 'label click text-ellipsis';
        label.textContent = 'Cleaner';
        link.appendChild(label);

        const badgeWrap = document.createElement('div');
        badgeWrap.className = 'janitor-badge-wrap';

        row.append(indent, iconBtn, link, badgeWrap);
        // No href, so nothing routes - the click only toggles our panel.
        row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
        return row;
    }

    /** Selected-state background + a native-looking badge with the pending move count. */
    function paintNavRow() {
        const row = document.getElementById(NAV_ID);
        if (!row) return;
        row.style.background = isOpen() ? 'rgba(128,128,128,.28)' : '';
        const wrap = row.querySelector('.janitor-badge-wrap');
        if (!wrap) return;
        const pendingMoves = state.plan ? [...state.plan.byTarget.values()].reduce((n, l) => n + l.length, 0) : 0;
        wrap.innerHTML = '';
        if (pendingMoves) {
            const badge = document.createElement('div');
            badge.className = 'counter-badge z2';
            // The native badge takes its pill colours from an inline style, not from the class - copy
            // them off a real one so ours doesn't render as bare text.
            const native = document.querySelector('.folder-row .counter-badge');
            if (native) badge.setAttribute('style', native.getAttribute('style') || '');
            badge.textContent = String(pendingMoves);
            wrap.appendChild(badge);
        }
    }

    function mountNavRow() {
        if (document.getElementById(NAV_ID)) return true;
        const anchor = inboxRow();
        if (!anchor || !anchor.parentElement) return false;
        anchor.parentElement.insertBefore(buildNavRow(anchor), anchor.nextSibling);
        paintNavRow();
        return true;
    }

    function watchSidebar() {
        const remount = debounce(mountNavRow, 150);
        new MutationObserver(() => { if (!document.getElementById(NAV_ID)) remount(); })
            .observe(document.body, { childList: true, subtree: true });
        // If Tuta ever restructures the sidebar out from under us, fall back to the floating button
        // rather than leaving the panel unreachable.
        setTimeout(() => { if (!document.getElementById(NAV_ID)) $('.fab').classList.add('show'); }, 10000);
    }

    // ------------------------------------------------------------- bootstrap

    (async function waitForTuta() {
        for (let i = 0; i < 120; i++) {
            const L = locator();
            if (L && L.mailModel && L.mailboxModel && L.logins && L.logins.isUserLoggedIn && L.logins.isUserLoggedIn()) {
                try {
                    await loadFolders();
                    render();
                    mountNavRow();
                    watchSidebar();
                    console.log('[janitor] ready -', state.folders.length, 'folders');
                    return;
                } catch (err) {
                    console.warn('[janitor] folder load failed, retrying', err);
                }
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        console.warn('[janitor] gave up waiting for the Tuta client model');
    })();
})();
