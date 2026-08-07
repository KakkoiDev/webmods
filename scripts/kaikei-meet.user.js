// ==UserScript==
// @name         Kaikei Lookup for Meet
// @namespace    http://tampermonkey.net/
// @icon         https://meet.google.com/favicon.ico
// @version      2026.08.07
// @license      MIT
// @description  Japanese-English accounting glossary lookup inside a Google Meet call
// @author       KakkoiDev
// @match        https://meet.google.com/*
// @match        https://chat.google.com/embed/*
// @grant        none
// ==/UserScript==

/**
 * Kaikei Lookup puts the ProOne accounting glossary one keystroke away during a meeting,
 * so a Japanese accounting term does not stop the conversation.
 *
 * Open with Alt+K, or the small 会 button in the bottom-left corner. Type Japanese,
 * English, or the kana reading; results filter as you type. Enter copies the top result.
 *
 * Vocabulary is GENERATED from ~/.claude/skills/kaikei/reference/glossary.md by
 * tools/gen-kaikei-terms.mjs. Do not hand-edit the TERMS block - regenerate it.
 *
 * UI placement: this deliberately does NOT dock into Meet's native toolbar. Meet's class
 * names are hashed and it rebuilds the bar constantly; Gmeet++ already carries the
 * re-injection machinery for that. A viewport-fixed panel cannot be torn out by a Meet
 * re-render and cannot shift the page, which is what a lookup tool needs.
 *
 * Send-to-chat: Google moved in-meeting chat into a cross-origin chat.google.com iframe,
 * so the Meet page cannot reach the composer. This script ALSO runs inside that iframe
 * (second @match) and the two halves talk over postMessage, the same shape gmeet-pp.user.js
 * uses. Three things that shape gets right and a naive single postMessage does not:
 *
 *   1. Open the chat panel first. With chat closed the iframe does not exist at all.
 *   2. Re-query the iframe and re-post every 250ms for 20s. On a cold open the element and
 *      the Chat app appear seconds after the toggle click; one post lands on nothing.
 *   3. Re-insert into the composer until Send enables. Chat's Lexical editor ignores an
 *      insert that arrives before it has initialised.
 *
 * Every attempt shares one id and the in-frame half dedups on it, so retrying never
 * double-posts. On failure the text is on the clipboard and the button says why.
 */

(function () {
    'use strict';

    const KAIKEI_TOKEN = 'kaikei-bridge-1'; // namespaces our postMessages; origin checks are the real guard
    const MEET_ORIGIN = 'https://meet.google.com';
    const CHAT_ORIGIN = 'https://chat.google.com';
    const DEBUG = true;

    // Two independent guards in the chat frame, because they stop different things:
    //   by id   - the parent re-posts the SAME attempt every 250ms until acked
    //   by text - the parent may fire a WHOLE NEW attempt, with a new id, when it thinks the
    //             first one is lost. Without this, an attempt that was actually fine and
    //             merely slow would put the line into the meeting twice, in front of everyone.
    // The text guard is what makes retrying safe, so retry freely above it.
    //
    // Declared here, ABOVE the host branch below. A const declared after that branch's
    // `return` is never initialised on the chat-frame path, and reading it throws.
    const SENT_TEXT_TTL_MS = 60000;

    // Two @match targets now, so branch on the host rather than assuming. The chat iframe
    // gets the send agent and nothing else. A host that is neither - an about:blank frame
    // that exists before its real navigation - gets nothing, or the panel ends up built
    // inside an invisible frame.
    if (location.hostname === 'chat.google.com') {
        initChatFrameAgent();
        return;
    }
    if (location.hostname !== 'meet.google.com') return;

    // ------------------------------------------------------- in-frame chat agent
    // Everything below this point up to initChatFrameAgent's end runs ONLY in the iframe.
    // Function declarations hoist, so the early return above still reaches them.

    function frameDbg(msg) {
        if (!DEBUG) return;
        // Report up to the Meet console so both halves land in one place.
        try { window.parent.postMessage({ kaikei: KAIKEI_TOKEN, type: 'diag', msg }, MEET_ORIGIN); } catch (e) { /* ignore */ }
        console.log('[Kaikei frame]', msg);
    }

    function initChatFrameAgent() {
        const handledIds = new Set();
        const doneText = new Map();  // text -> { status, at }   SETTLED results only
        const inflight = new Map();  // text -> Promise<status>  a send still running

        const alreadyDone = (text) => {
            const hit = doneText.get(text);
            if (!hit) return null;
            if (Date.now() - hit.at > SENT_TEXT_TTL_MS) { doneText.delete(text); return null; }
            return hit.status;
        };

        // Readiness handshake. The parent used to fire sends optimistically into a frame that
        // might have no composer yet and hope one of them stuck. Now it can just ask, which
        // is what a human clicking a second time is really doing: waiting until the thing
        // exists, then acting once.
        window.addEventListener('message', (e) => {
            if (e.origin !== MEET_ORIGIN) return;
            const d = e.data;
            if (!d || d.kaikei !== KAIKEI_TOKEN || d.type !== 'ping') return;
            const box = document.querySelector('[contenteditable="true"][role="textbox"]');
            try {
                e.source?.postMessage(
                    { kaikei: KAIKEI_TOKEN, type: 'pong', id: d.id, ready: Boolean(box) },
                    e.origin,
                );
            } catch (err) { /* ignore */ }
        });

        window.addEventListener('message', (e) => {
            if (e.origin !== MEET_ORIGIN) return;
            const d = e.data;
            if (!d || d.kaikei !== KAIKEI_TOKEN || d.type !== 'send') return;
            if (d.id && handledIds.has(d.id)) return;
            if (d.id) handledIds.add(d.id);

            const ack = (status) => {
                try {
                    e.source?.postMessage(
                        { kaikei: KAIKEI_TOKEN, type: 'send-ack', id: d.id, status },
                        e.origin,
                    );
                } catch (err) { /* ignore */ }
            };

            const prior = alreadyDone(d.text);
            if (prior) {
                frameDbg('same text already ' + prior + ' - acking without sending again');
                ack(prior);
                return;
            }
            // A second attempt for the same text while the first is still running must NOT
            // start its own send, and must NOT be told 'sent' on the strength of the first
            // one merely having started. Optimistically recording 'sent' here is what made
            // the button say Sent while nothing reached the meeting. Ride the same promise
            // and report whatever it really resolves to.
            const running = inflight.get(d.text);
            if (running) {
                frameDbg('same text already in flight - waiting for its real result');
                running.then(ack);
                return;
            }

            frameDbg('recv send id=' + String(d.id || '').slice(-6));
            const p = waitForComposer(d.text).then((status) => {
                inflight.delete(d.text);
                // 'failed' is not recorded, so a later attempt is free to try again.
                if (status !== 'failed') doneText.set(d.text, { status, at: Date.now() });
                return status;
            });
            inflight.set(d.text, p);
            p.then((status) => { frameDbg('ack ' + status); ack(status); });
        });
        // Announce unconditionally, not only under DEBUG: the Meet half uses this to tell a
        // missing agent apart from a composer that would not accept the text.
        try { window.parent.postMessage({ kaikei: KAIKEI_TOKEN, type: 'hello' }, MEET_ORIGIN); } catch (e) { /* ignore */ }
        frameDbg('agent ready');
    }

    // Chat renders its composer asynchronously after the frame loads.
    function waitForComposer(text) {
        return new Promise((resolve) => {
            const start = Date.now();
            const attempt = () => {
                const box = document.querySelector('[contenteditable="true"][role="textbox"]');
                if (box) { frameDbg('composer found @' + (Date.now() - start) + 'ms'); insertAndSend(box, text).then(resolve); return; }
                if (Date.now() - start > 8000) { frameDbg('composer never appeared'); resolve('failed'); return; }
                setTimeout(attempt, 150);
            };
            attempt();
        });
    }

    // Resolves 'sent' (clicked an enabled Send), 'manual' (text is in the box but Send never
    // enabled, so the user presses Enter - Chat ignores untrusted synthetic Enter and we do
    // not fake it), or 'failed' (text never landed).
    function insertAndSend(box, text) {
        return new Promise((resolve) => {
            // jsname values are generated and Google rotates them, so a single hardcoded one
            // is a fuse waiting to blow: the text lands in the composer and then nothing ever
            // clicks Send. Try the known value, then the accessible name, then the only
            // enabled button sitting next to the composer.
            const sendBtn = () => {
                const byJs = document.querySelector('button[jsname="GBTyxb"]');
                if (byJs) return byJs;
                const labelled = [...document.querySelectorAll('button[aria-label], button[data-tooltip]')]
                    .find((b) => /send|送信/i.test(b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || ''));
                if (labelled) return labelled;
                const scope = box.closest('form') || box.parentElement?.parentElement || document;
                const near = [...scope.querySelectorAll('button')].filter((b) => !b.disabled);
                return near.length === 1 ? near[0] : null;
            };
            let btnReported = false;
            const focusEnd = () => {
                try {
                    box.focus();
                    const r = document.createRange(); r.selectNodeContents(box); r.collapse(false);
                    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                } catch (err) { /* ignore */ }
            };
            const clearBox = () => {
                try {
                    box.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                } catch (err) { /* ignore */ }
            };
            // The first click typed nothing because this used to bail out on
            // `!document.hasFocus()`. The caller's focus is in the lookup box up in the Meet
            // page, so the chat frame legitimately reports no focus, and skipping on that
            // burned the entire deadline waiting for focus that only arrives when the user
            // clicks a second time. Never skip. Take focus, then try three insert paths in
            // order of how much focus they need, and let whichever one lands, land.
            const grabFocus = () => {
                // Self-focus from inside the frame. Same-origin to itself, so this is allowed
                // even when the parent is another origin, and it is what the second click was
                // really doing for us.
                try { window.focus(); } catch (err) { /* ignore */ }
                focusEnd();
            };
            const landed = () => Boolean((box.textContent || '').trim());
            const doInsert = () => {
                grabFocus();
                // 1. execCommand, which writes through the editor's own undo stack. Needs the
                //    frame focused, so it is first but never the only attempt.
                try { document.execCommand('insertText', false, text); } catch (err) { /* ignore */ }
                // 2. A synthetic paste. Lexical handles paste off the event, not off focus.
                if (!landed()) {
                    try {
                        const dt = new DataTransfer();
                        dt.setData('text/plain', text);
                        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                    } catch (err) { /* ignore */ }
                }
                // 3. beforeinput + direct write + input. No focus, no selection, no clipboard.
                //    Crude, and some editors ignore it, but it costs nothing to try and it is
                //    the only path left when the frame cannot get focus at all.
                if (!landed()) {
                    try {
                        box.dispatchEvent(new InputEvent('beforeinput', {
                            bubbles: true, cancelable: true, inputType: 'insertText', data: text,
                        }));
                        if (!landed()) box.textContent = text;
                        box.dispatchEvent(new InputEvent('input', {
                            bubbles: true, inputType: 'insertText', data: text,
                        }));
                    } catch (err) { /* ignore */ }
                }
                return landed();
            };

            let attempts = 1;
            frameDbg('insert 1 hasFocus=' + document.hasFocus() + ' landed=' + doInsert());
            let lastInsert = Date.now();
            let rounds = 0;
            // Focus can take a moment to arrive from the parent, so allow longer than the
            // insert alone would need.
            let deadline = Date.now() + 8000;
            const tick = () => {
                const b = sendBtn();
                if (b && !btnReported) { btnReported = true; frameDbg('send button found via ' + (b.getAttribute('jsname') ? 'jsname' : b.getAttribute('aria-label') ? 'aria-label' : 'position')); }
                if (b && !b.disabled) {
                    rounds += 1;
                    b.click();
                    frameDbg('clicked send (round ' + rounds + ')');
                    // Clicking is not sending. Chat can swallow the click while the thread is
                    // still binding and leave the text sitting in the composer, which is what
                    // an ack of 'sent' used to lie about. Read the thread back instead.
                    verifySent(box, text).then((ok) => {
                        if (ok) { resolve('sent'); return; }
                        if (rounds >= 3) { frameDbg('clicked ' + rounds + 'x, never appeared in the thread'); resolve((box.textContent || '').trim() ? 'manual' : 'failed'); return; }
                        clearBox();
                        frameDbg('unverified, re-insert and click again, hasFocus=' + document.hasFocus() + ' landed=' + doInsert());
                        lastInsert = Date.now();
                        deadline = Date.now() + 8000; // a verification round burned the old one
                        setTimeout(tick, 300);
                    });
                    return;
                }
                // Send still disabled after a beat means the editor was not ready, or the
                // frame did not have focus, when we inserted. Retry quickly while the box is
                // still empty - that is the focus case and it clears as soon as focus lands.
                const empty = !(box.textContent || '').trim();
                const wait = empty ? 400 : 1200;
                if (Date.now() - lastInsert > wait && attempts < 12) {
                    if (!empty) clearBox();
                    attempts += 1;
                    frameDbg('re-insert ' + attempts + ' hasFocus=' + document.hasFocus() + ' landed=' + doInsert());
                    lastInsert = Date.now();
                }
                if (Date.now() < deadline) { setTimeout(tick, 250); return; }
                const landed = Boolean((box.textContent || '').trim());
                frameDbg('send never enabled -> ' + (landed ? 'manual' : 'failed'));
                resolve(landed ? 'manual' : 'failed');
            };
            setTimeout(tick, 250);
        });
    }

    // ------------------------------------------------------------ Gemini in Meet
    // "Gemini に相談" renders its composer in the Meet document itself, not in a
    // cross-origin iframe like chat. No bridge, no postMessage, no second @match: this
    // path is same-origin and cannot hit the chat frame's failure modes.
    const GEMINI_BOX = '[contenteditable="true"][role="combobox"][aria-label*="Gemini"], div[jsname="ZeIRi"][contenteditable="true"]';
    const GEMINI_OPEN = 'button[jsname="J4YcA"]';
    const GEMINI_CHUNK = 6000; // conservative; the box's real input ceiling is undocumented

    function geminiBox() { return document.querySelector(GEMINI_BOX); }

    // Survives the lookup panel closing, so it can report on what the panel just did.
    function toast(msg) {
        document.getElementById('kaikei-toast')?.remove();
        const t = document.createElement('div');
        t.id = 'kaikei-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('kaikei-fade'), 5000);
        setTimeout(() => t.remove(), 5600);
    }

    // The house rules a generic translation gets wrong. These are the terms that actually
    // derail a ProOne accounting conversation, so they lead the payload rather than sitting
    // at the bottom of 181 lines the model may skim.
    function geminiPreamble() {
        return [
            'You are sitting in a Meetsmore engineering call about the ProOne accounting feature',
            '(invoices, transactions, consumption tax). Below is our internal Japanese/English',
            'glossary. Treat it as authoritative for this call: when one of these Japanese terms',
            'comes up, use the English given here, not a generic dictionary translation, and keep',
            'the Japanese term alongside it so both halves of the room can follow.',
            '',
            'LANGUAGE: mirror whoever is speaking to you. Japanese question, answer in Japanese.',
            'English question, answer in English. A mixed question follows its dominant language.',
            'Switch as often as the question does, with no announcement and no asking which I want.',
            'Whatever language you answer in, give every glossary term in both: 受注 (order received).',
            '',
            'JAPAN FIRST, ALWAYS UNPROMPTED. Every term here means what it means under Japanese',
            'accounting and Japanese B2B commercial practice. When that differs from what a',
            'Western-trained reader would assume, say so in the FIRST sentence, before the',
            'definition, and never wait to be asked whether there is a Japanese angle. Answering',
            'in English is when this matters most: the person asking is usually the one who does',
            'not know the practice differs. A generic textbook definition that happens to be true',
            'in the abstract is a wrong answer here. If you are unsure whether a term diverges,',
            'say you are unsure rather than giving the Western default.',
            '',
            'DIVERGENCES that catch English speakers, as worked examples of the rule above:',
            '- 締め日 is a monthly BILLING CUTOFF, not "the end of an accounting period". Deliveries',
            '  are accumulated to the cutoff and billed as one invoice on a fixed cycle, typically',
            '  月末締め翌月末払い (cut at month end, paid at the end of the next month). It is not',
            '  per-transaction net-30.',
            '- インボイス制度 (qualified invoice system, since Oct 2023) has no Western equivalent. The',
            '  supplier\'s 適格請求書発行事業者登録番号 must be on the invoice or the buyer loses the',
            '  input tax credit. It is not a formality.',
            '- 消費税 rounding follows NTA No.6371: one rounding per tax-rate group per invoice, NOT',
            '  per line item. Line-item rounding is the Western habit and it is wrong here.',
            '- 検収 is a formal, dated customer acceptance event that gates revenue recognition.',
            '  Recognising on delivery, as is common in the West, is not how this works.',
            '- 源泉徴収 (withholding at source) applies to some B2B service payments. Most Western AP',
            '  processes have no equivalent step.',
            '- 決算期 commonly ends 31 March, not 31 December. Do not assume a calendar fiscal year.',
            '',
            'TRAPS - these are what a normal translator gets wrong:',
            '- 受注 carries four distinct meanings: a phase name, a phase type, an order status whose',
            '  Japanese label is actually 完了, and a derived estimate status. Ask which one is meant',
            '  rather than picking one.',
            '- 発注残 is the PURCHASE-order backlog (what we owe suppliers). 受注残 is the SALES-order',
            '  backlog (what customers owe us). Never swap them.',
            '- 消し込み means clearing a receivable, several steps after delivery. It was explicitly',
            '  rejected as a name for leaving the order backlog. Do not use it for that.',
            '- 検収 is customer acceptance, the event that permits revenue recognition. 役務完了 is',
            '  service completion. Different events on different dates.',
            '- 税区分 is a tax CATEGORY CODE, not a rate.',
            '- 請求書 is an invoice we issue. 被請求書 is a supplier bill we receive.',
            '',
        ].join('\n');
    }

    // Everything the glossary knows goes to the model: reading, English, the note (the notes
    // are where the codebase-specific meaning lives), both example sentences, and the domain
    // section headers so related terms stay related. Text is the cheap part of priming; a
    // term Gemini was never told about is a term it will answer from Western training data.
    function geminiPayload(compact) {
        const out = [geminiPreamble()
            + 'GLOSSARY, grouped by domain. Format: 日本語（reading）= English | note,'
            + (compact ? '' : ' with 例:/EN: example-sentence pairs,')
            + ' one term per entry:'];
        let sec = null;
        for (const t of TERMS) {
            const label = t.se || t.s;
            if (label && label !== sec) { sec = label; out.push('', '## ' + sec); }
            let line = (t.r ? t.j + '（' + t.r + '）' : t.j) + ' = ' + t.e;
            if (t.n) line += ' | ' + t.n;
            out.push(line);
            if (!compact && t.xj) {
                out.push('  例: ' + t.xj);
                if (t.xe) out.push('  EN: ' + t.xe);
            }
        }
        return out.join('\n');
    }

    // Split on line boundaries so a term never lands half in one message and half in the next.
    function chunk(text, size) {
        const out = [];
        let buf = '';
        for (const ln of text.split('\n')) {
            if (buf.length + ln.length + 1 > size && buf) { out.push(buf); buf = ''; }
            buf += (buf ? '\n' : '') + ln;
        }
        if (buf) out.push(buf);
        return out;
    }

    // Resolves 'sent' | 'no-gemini' | 'failed'.
    async function primeGemini(compact, onStage) {
        let box = geminiBox();
        if (!box) {
            const opener = document.querySelector(GEMINI_OPEN);
            if (!opener) return 'no-gemini';
            onStage('Opening Gemini...');
            opener.click();
            for (let i = 0; i < 40 && !box; i++) { await after(150); box = geminiBox(); }
            if (!box) return 'no-gemini';
        }
        // One message if the box will take it. Splitting is where this breaks: after part 1
        // goes, Gemini starts writing its answer and holds the composer for as long as that
        // takes, so a part inserted or clicked during that window goes nowhere.
        const payload = geminiPayload(compact);
        const full = '[Kaikei glossary] Reply "Ready / 準備完了" and wait.\n\n' + payload;
        onStage('Sending...');
        // Short budget on the probe: this one is measuring the ceiling, and a payload that is
        // genuinely too big should reach the split in seconds, not after a minute of retries.
        const one = await composerInsert(box, full, 8000);
        if (one.ok) {
            if (await sendAndVerify(box, () => geminiSendBtn(box), 30000, "gemini")) {
                dbg('gemini: whole glossary in one message, ' + full.length + ' chars');
                return 'sent';
            }
            dbg('gemini: one-message send never cleared the box, falling back to parts');
        } else {
            dbg('gemini: box took ' + one.accepted + ' of ' + full.length + ' chars, splitting');
        }

        // Chunk to what the box has DEMONSTRATED it accepts, never to a constant. A guessed
        // chunk size above the real ceiling is worse than not splitting at all: every part
        // is refused in turn and nothing whatsoever reaches Gemini.
        let size = one.accepted > 600 && one.accepted < full.length
            ? Math.floor(one.accepted * 0.8)
            : GEMINI_CHUNK;

        // Two passes at most. Re-measuring is allowed only while nothing has been sent yet -
        // restarting after a part has landed would repeat it into the conversation.
        for (let pass = 1; pass <= 2; pass++) {
            const parts = chunk(payload, Math.max(600, size - 200));
            dbg('gemini: ' + parts.length + ' parts at ~' + size + ' chars');
            let sentAny = false;
            let refusedAt = 0;
            for (let i = 0; i < parts.length; i++) {
                const tag = '[Kaikei glossary ' + (i + 1) + '/' + parts.length + ']'
                    + (i < parts.length - 1
                        ? ' Reply with OK only, more follows.\n\n'
                        : ' That is all. Reply "Ready / 準備完了" and wait.\n\n');
                onStage('Sending ' + (i + 1) + '/' + parts.length + '...');
                box = geminiBox() || box;
                // 90s, because most of this wait is Gemini finishing its reply to the
                // previous part while the composer throws away anything typed into it.
                const r = await composerInsert(box, tag + parts[i], 90000);
                if (!r.ok) {
                    dbg('gemini: part ' + (i + 1) + ' did not fit, box took ' + r.accepted);
                    refusedAt = r.accepted;
                    break;
                }
                // Generous: the wait here is Gemini writing its reply to the previous part.
                if (!await sendAndVerify(box, () => geminiSendBtn(box), 120000, "gemini")) {
                    dbg('gemini: part ' + (i + 1) + '/' + parts.length + ' never left the box');
                    return 'failed';
                }
                sentAny = true;
                dbg('gemini: part ' + (i + 1) + '/' + parts.length + ' sent');
                if (i === parts.length - 1) return 'sent';
            }
            if (sentAny || refusedAt < 600) return 'failed';
            size = Math.floor(refusedAt * 0.8);
        }
        return 'failed';
    }

    // Inserts, then reports how much the box actually holds. The count matters as much as
    // the verdict: a short result measures the composer's ceiling, and the split above uses
    // that measurement rather than guessing at it.
    //
    // Two distinct reasons an insert comes up short, and they need opposite responses:
    //   the composer is too small     - a real ceiling, stop and split to it
    //   Gemini is answering           - transient, the composer discards input until it is
    //                                   done, so keep re-inserting until the budget runs out
    // `accepted` reports the PEAK the box ever held, never the momentary zero left behind by
    // a busy composer - reading that zero as a ceiling would chunk the payload to nothing.
    // A textarea keeps its text in .value and leaves textContent empty forever, so reading
    // textContent on one measures every insert as zero: a refusal that never happened.
    const isField = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    const boxText = (el) => (isField(el) ? el.value : el.textContent) || '';

    function selectAllIn(el) {
        el.focus();
        if (isField(el)) { el.select(); return; }
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        document.execCommand('selectAll', false, null);
    }

    async function composerInsert(box, text, timeoutMs) {
        const strip = (s) => (s || '').replace(/\s+/g, '').length;
        const want = strip(text);
        const deadline = Date.now() + (timeoutMs || 6000);
        let peak = 0;
        let attempt = 0;
        while (Date.now() < deadline) {
            attempt += 1;
            try {
                selectAllIn(box);
                document.execCommand('insertText', false, text);
                // A field that ignored execCommand still takes a direct assignment, provided
                // the framework hears the input event that normally follows one.
                if (isField(box) && strip(box.value) < want) {
                    box.value = text;
                    box.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } catch (err) { /* ignore */ }
            for (let i = 0; i < 15; i++) {
                const raw = boxText(box).length;
                if (raw > peak) peak = raw;
                if (strip(boxText(box)) >= want) return { ok: true, accepted: raw };
                if (Date.now() >= deadline) break;
                await after(100);
            }
            if (attempt === 1 || attempt % 8 === 0) {
                dbg('insert try ' + attempt + ', box peaked at ' + peak + ' raw, wanted ' + want);
            }
        }
        dbg('insert gave up after ' + attempt + ' tries, peak ' + peak + ' raw');
        return { ok: false, accepted: peak };
    }

    // Click Send, then confirm the composer actually emptied. Clicking an enabled button is
    // not a send: the app swallows the click while it is busy and leaves the text in the box.
    // Treating that as success is how a Gemini part went missing.
    //
    // `findBtn` is passed in because the same insert-verify-resend shape now drives both the
    // Gemini composer and Meet's own in-page chat composer; only the button differs.
    async function sendAndVerify(box, findBtn, timeoutMs, tag) {
        const deadline = Date.now() + timeoutMs;
        for (let round = 1; round <= 3; round++) {
            const left = deadline - Date.now();
            if (left <= 0) break;
            if (!await clickWhenEnabled(findBtn, left, tag)) break;
            for (let i = 0; i < 25; i++) {
                if (!boxText(box).trim()) return true;
                await after(200);
            }
            dbg(tag + ': clicked send (round ' + round + ') and the box still holds text');
        }
        return false;
    }

    // Google's widgets frequently act on pointerdown/mousedown rather than click, so a bare
    // .click() - which fires only the click event - can land on a button that then does
    // nothing. Send the whole sequence a real press produces.
    function hardClick(b) {
        const opts = { bubbles: true, cancelable: true, view: window };
        try {
            b.dispatchEvent(new PointerEvent('pointerdown', opts));
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new PointerEvent('pointerup', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (err) { /* ignore */ }
        b.click();
    }

    function clickWhenEnabled(findBtn, timeoutMs, tag) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const tick = () => {
                const b = findBtn();
                if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
                    hardClick(b);
                    resolve(true);
                    return;
                }
                if (Date.now() > deadline) {
                    dbg(tag + ': send never enabled within ' + timeoutMs + 'ms, found=' + Boolean(b));
                    resolve(false);
                    return;
                }
                setTimeout(tick, 200);
            };
            setTimeout(tick, 250);
        });
    }

    function geminiSendBtn(box) {
        const scope = box.closest('[jscontroller]')?.parentElement || document;
        return [...scope.querySelectorAll('button')]
            .find((b) => /送信|^send$/i.test(b.getAttribute('aria-label') || ''))
            || document.querySelector('button[jsname="LgbsSe"][aria-label]');
    }

    // Did the message actually reach the thread? Two signals, strongest first:
    //   1. the text is rendered somewhere that is not the composer - it is in the thread
    //   2. the composer emptied - Chat clears it on a send it accepted, and leaves the text
    //      alone on a click it swallowed, so an empty box is the discriminator even before
    //      the new message paints
    // Text still in the box after the window means the click did nothing.
    function verifySent(box, text) {
        return new Promise((resolve) => {
            const start = Date.now();
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const needle = norm(text).slice(0, 40);
            const inThread = () => {
                if (!needle) return false;
                for (const n of document.querySelectorAll('[data-message-id], [role="listitem"], [role="row"], [jsname]')) {
                    if (n === box || box.contains(n) || n.contains(box)) continue;
                    if (norm(n.textContent).includes(needle)) return true;
                }
                return false;
            };
            const tick = () => {
                if (inThread()) { frameDbg('verified: message is in the thread @' + (Date.now() - start) + 'ms'); resolve(true); return; }
                const empty = !(box.textContent || '').trim();
                const ms = Date.now() - start;
                // Give the thread a beat to render before trusting the weaker signal alone.
                if (empty && ms > 900) { frameDbg('verified: composer cleared, thread not painted yet'); resolve(true); return; }
                // Chat clears the composer the moment it accepts a send. Text still sitting
                // there after two seconds means the click was swallowed - go again now rather
                // than spending the whole window waiting for something that will not happen.
                if (!empty && ms > 2000) { frameDbg('NOT verified @' + ms + 'ms, composer still holds the text'); resolve(false); return; }
                if (ms > 5000) { frameDbg('NOT verified after 5s, composer ' + (empty ? 'empty' : 'still holds the text')); resolve(empty); return; }
                setTimeout(tick, 200);
            };
            tick();
        });
    }

    /* BEGIN GENERATED TERMS */
    // Generated by tools/gen-kaikei-terms.mjs - do not hand-edit.
    const TERMS = [
        {"j":"引合","r":"ひきあい","o":"hikiai","e":"inquiry / sales lead","n":"First contact from a prospective customer, before any quote; the top of the sales funnel","xj":"新規のお客様から引合をいただきました。","xe":"We received an inquiry from a new customer.","xf":"新規【しんき】のお客様【きゃくさま】から引合【ひきあい】をいただきました。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"見積","r":"みつもり","o":"mitsumori","e":"quote / estimate","n":"Price proposal before the order; the accepted version becomes the order's baseline","xj":"見積を作成してお送りします。","xe":"I will prepare a quote and send it to you.","xf":"見積【みつもり】を作成【さくせい】してお送【おく】りします。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"受注","r":"じゅちゅう","o":"juchuu","e":"order received","n":"Winning a customer order, mirror of 発注; four codebase meanings, so always ask which is meant","xj":"先月の受注が増えました。","xe":"Orders received increased last month.","xf":"先月【せんげつ】の受注【じゅちゅう】が増【ふ】えました。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"契約","r":"けいやく","o":"keiyaku","e":"contract","n":"The signed agreement; in construction the 請負契約 fixing scope and price","xj":"来週、契約を締結します。","xe":"We will conclude the contract next week.","xf":"来週【らいしゅう】、契約【けいやく】を締結【ていけつ】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"着工","r":"ちゃっこう","o":"chakkou","e":"start of construction","n":"Construction start; a billing milestone under installment terms (着工時金)","xj":"来月から着工の予定です。","xe":"Construction is scheduled to start next month.","xf":"来月【らいげつ】から着工【ちゃっこう】の予定【よてい】です。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"役務提供","r":"えきむていきょう","o":"ekimuteikyou","e":"service delivery","n":"Performing the service itself; its progress drives service revenue timing","xj":"役務提供が完了した時点で計上します。","xe":"We record it at the point when service delivery is completed.","xf":"役務提供【えきむていきょう】が完了【かんりょう】した時点【じてん】で計上【けいじょう】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"出来高","r":"できだか","o":"dekidaka","e":"progress / earned value","n":"Value of work completed to date; the basis of progress billing (出来高請求) in construction","xj":"今月の出来高で請求します。","xe":"We will bill based on this month's progress.","xf":"今月【こんげつ】の出来高【できだか】で請求【せいきゅう】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"検収","r":"けんしゅう","o":"kenshuu","e":"acceptance / inspection","n":"The customer confirming delivered work is acceptable. The event that permits recognition","xj":"お客様の検収が終わりました。","xe":"The customer's acceptance inspection is finished.","xf":"お客様【きゃくさま】の検収【けんしゅう】が終【お】わりました。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"納品書","r":"のうひんしょ","o":"nouhinsho","e":"delivery slip","n":"Accompanies the goods as proof of delivery; evidence of the date, not a bill","xj":"納品書を添付してお送りします。","xe":"I will attach the delivery slip and send it.","xf":"納品書【のうひんしょ】を添付【てんぷ】してお送【おく】りします。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"引渡","r":"ひきわたし","o":"hikiwatashi","e":"handover","n":"Formal transfer of the finished work; the revenue trigger under the completed-contract method","xj":"今週末に引渡の予定です。","xe":"The handover is scheduled for this weekend.","xf":"今週末【こんしゅうまつ】に引渡【ひきわたし】の予定【よてい】です。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"完成","r":"かんせい","o":"kansei","e":"completion","n":"Physical completion; distinct from 引渡 (handover) and 検収 (acceptance)","xj":"工事が完成しました。","xe":"The construction work has been completed.","xf":"工事【こうじ】が完成【かんせい】しました。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"発注","r":"はっちゅう","o":"hacchuu","e":"place a purchase order","n":"Placing an order TO a supplier; the purchase-side mirror of 受注","xj":"必要な資材を発注します。","xe":"We will place a purchase order for the needed materials.","xf":"必要【ひつよう】な資材【しざい】を発注【はっちゅう】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"発注書","r":"はっちゅうしょ","o":"hacchuusho","e":"purchase order (document)","n":"The PO document sent to the supplier; the paper trail behind 発注","xj":"発注書を作成して送付します。","xe":"I will prepare the purchase order document and send it.","xf":"発注書【はっちゅうしょ】を作成【さくせい】して送付【そうふ】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"仕入","r":"しいれ","o":"shiire","e":"purchasing / procurement","n":"Buying goods or services in; the cost side, booked via 仕入計上","xj":"今月の仕入が増えました。","xe":"Our purchasing increased this month.","xf":"今月【こんげつ】の仕入【しいれ】が増【ふ】えました。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"分納","r":"ぶんのう","o":"bunnou","e":"split delivery","n":"Delivering one order in installments; each partial delivery can bill and recognize separately","xj":"今回は分納で対応します。","xe":"This time we will handle it with split delivery.","xf":"今回【こんかい】は分納【ぶんのう】で対応【たいおう】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"発注残","r":"はっちゅうざん","o":"hacchuuzan","e":"PURCHASE-order backlog (outgoing; contrast 受注残 = sales-order backlog)","n":"Open POs not yet delivered; spend already committed to suppliers","xj":"発注残を確認しておきます。","xe":"I will check the order backlog in advance.","xf":"発注残【はっちゅうざん】を確認【かくにん】しておきます。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"請求書","r":"せいきゅうしょ","o":"seikyuusho","e":"invoice (issued)","n":"The bill we issue; must carry the registration number and per-rate tax totals under the invoice system","xj":"月末に請求書を発行します。","xe":"We will issue the invoice at the end of the month.","xf":"月末【げつまつ】に請求書【せいきゅうしょ】を発行【はっこう】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"被請求書","r":"ひせいきゅうしょ","o":"hiseikyuusho","e":"received invoice (supplier bill)","n":"In-house label for a bill we receive; ordinary bookkeeping says 請求書 on the AP side too","xj":"取引先からの被請求書を処理します。","xe":"We will process the received invoice from the supplier.","xf":"取引【とりひき】先【さき】からの被請求書【ひせいきゅうしょ】を処理【しょり】します。","s":"Tier 1 - 業務フロー / Business Flow","se":"Tier 1 - Business Flow"},
        {"j":"計上","r":"けいじょう","o":"keijou","e":"record / recognize (book)","n":"Booking an amount into the accounts under a date; the everyday verb for recognize","xj":"この経費は今月に計上します。","xe":"We will book this expense in the current month.","xf":"この経費【けいひ】は今月【こんげつ】に計上【けいじょう】します。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"認識","r":"にんしき","o":"ninshiki","e":"recognition (judgment)","n":"The judgment of when revenue or cost exists; 計上 is the act of recording it","xj":"収益の認識について確認します。","xe":"Let me confirm the revenue recognition.","xf":"収益【しゅうえき】の認識【にんしき】について確認【かくにん】します。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"記帳","r":"きちょう","o":"kichou","e":"bookkeeping","n":"The clerical act of writing entries into the books, not the judgment","xj":"毎日の記帳をお願いします。","xe":"Please handle the daily bookkeeping.","xf":"毎日【まいにち】の記帳【きちょう】をお願【ねが】いします。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"売上計上","r":"うりあげけいじょう","o":"uriagekeijou","e":"sales recognition","n":"Booking revenue; the date follows the chosen basis: delivery, acceptance, or progress","xj":"売上計上は完了日に行います。","xe":"We recognize sales on the completion date.","xf":"売上計上【うりあげけいじょう】は完了日【かんりょうび】に行【おこな】います。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"仕入計上","r":"しいれけいじょう","o":"shiirekeijou","e":"cost recognition","n":"Booking purchase cost, typically on delivery or acceptance of the supplier's work","xj":"仕入計上のタイミングを確認します。","xe":"Let me check the timing of the cost recognition.","xf":"仕入計上【しいれけいじょう】のタイミングを確認【かくにん】します。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"部分計上","r":"ぶぶんけいじょう","o":"bubunkeijou","e":"partial recognition","n":"Recognizing only part of an amount, per delivery or per progress","xj":"進捗に応じて部分計上します。","xe":"We recognize it partially according to progress.","xf":"進捗【しんちょく】に応【おう】じて部分計上【ぶぶんけいじょう】します。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"計上日","r":"けいじょうび","o":"keijoubi","e":"recognition date","n":"The date an amount is booked under; decides which period it lands in, hence the 期ずれ risk","xj":"計上日は月末に設定します。","xe":"We set the recognition date to the end of the month.","xf":"計上日【けいじょうび】は月末【げつまつ】に設定【せってい】します。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"計上基準","r":"けいじょうきじゅん","o":"keijoukijun","e":"recognition basis","n":"The rule choosing the recognition date: delivery, acceptance, service completion, progress","xj":"計上基準を全社で統一します。","xe":"We standardize the recognition basis across the company.","xf":"計上基準【けいじょうきじゅん】を全社【ぜんしゃ】で統一【とういつ】します。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"取消","r":"とりけし","o":"torikeshi","e":"cancellation","n":"Voiding an entry entirely; done with a reversing entry, never by deleting history","xj":"誤った仕訳の取消を行います。","xe":"We will carry out the cancellation of the incorrect journal entry.","xf":"誤【あやま】った仕訳【しわけ】の取消【とりけし】を行【おこな】います。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"訂正","r":"ていせい","o":"teisei","e":"correction","n":"Fixing a wrong entry; proper form is reversal plus re-entry, not overwriting","xj":"金額の訂正をお願いします。","xe":"Please make a correction to the amount.","xf":"金額【きんがく】の訂正【ていせい】をお願【ねが】いします。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"自動仕訳","r":"じどうしわけ","o":"jidoushiwake","e":"auto journal","n":"Entries the system generates from transactions instead of an accountant typing them","xj":"この取引は自動仕訳で処理されます。","xe":"This transaction is processed by auto journal generation.","xf":"この取引【とりひき】は自動仕訳【じどうしわけ】で処理【しょり】されます。","s":"Tier 2 - 計上・認識 / Recognition","se":"Tier 2 - Recognition"},
        {"j":"仕訳","r":"しわけ","o":"shiwake","e":"journal entry","n":"The debit-credit pair recording one event; the atom of double-entry bookkeeping","xj":"経費の仕訳を入力しておきます。","xe":"I will enter the journal entry for the expense.","xf":"経費【けいひ】の仕訳【しわけ】を入力【にゅうりょく】しておきます。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"仕訳明細","r":"しわけめいさい","o":"shiwakemeisai","e":"journal line","n":"One debit or credit line inside a journal entry","xj":"仕訳明細を一行ずつ確認します。","xe":"I will check each journal line one by one.","xf":"仕訳明細【しわけめいさい】を一行【いちぎょう】ずつ確認【かくにん】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"借方","r":"かりかた","o":"karikata","e":"debit","n":"Left side; where assets and expenses increase. かり's り hooks left","xj":"借方に現金を計上します。","xe":"We record cash on the debit side.","xf":"借方【かりかた】に現金【げんきん】を計上【けいじょう】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"貸方","r":"かしかた","o":"kashikata","e":"credit","n":"Right side; where liabilities and revenue increase. かし's し hooks right","xj":"貸方に売上を計上します。","xe":"We record sales on the credit side.","xf":"貸方【かしかた】に売上【うりあげ】を計上【けいじょう】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"勘定科目","r":"かんじょうかもく","o":"kanjoukamoku","e":"account title","n":"Named constants to GL accounts: 売掛金, 売上高, 外注費, 未払金 - chart of accounts","xj":"勘定科目を正しく選んでください。","xe":"Please select the correct account title.","xf":"勘定科目【かんじょうかもく】を正【ただ】しく選【えら】んでください。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"補助科目","r":"ほじょかもく","o":"hojokamoku","e":"sub-account","n":"Sub-division of a GL account, by customer or project, without adding accounts","xj":"補助科目で取引先を分けます。","xe":"We separate business partners using sub-accounts.","xf":"補助科目【ほじょかもく】で取引【とりひき】先【さき】を分【わ】けます。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"総勘定元帳","r":"そうかんじょうもとちょう","o":"soukanjoumotochou","e":"general ledger","n":"Every entry organized per account; the source of the trial balance","xj":"総勘定元帳で残高を確認します。","xe":"We check the balance in the general ledger.","xf":"総勘定元帳【そうかんじょうもとちょう】で残高【ざんだか】を確認【かくにん】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"振替仕訳","r":"ふりかえしわけ","o":"furikaeshiwake","e":"transfer / adjusting entry","n":"Moves an amount between accounts, e.g. WIP into completed cost","xj":"月末に振替仕訳を起こします。","xe":"We create a transfer entry at month-end.","xf":"月末【げつまつ】に振替仕訳【ふりかえしわけ】を起【お】こします。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"逆仕訳","r":"ぎゃくしわけ","o":"gyakushiwake","e":"reversing entry","n":"Debits and credits swapped to undo a prior entry; the audit-safe cancel","xj":"誤りは逆仕訳で取り消します。","xe":"We cancel the error with a reversing entry.","xf":"誤【あやま】りは逆仕訳【ぎゃくしわけ】で取【と】り消【け】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"複合仕訳","r":"ふくごうしわけ","o":"fukugoushiwake","e":"compound entry","n":"One entry with several debit or credit lines balancing in total","xj":"複合仕訳で複数の勘定をまとめて計上します。","xe":"We record multiple accounts together with a compound journal entry.","xf":"複合仕訳【ふくごうしわけ】で複数【ふくすう】の勘定【かんじょう】をまとめて計上【けいじょう】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"明細","r":"めいさい","o":"meisai","e":"line item","n":"One line of any document; per-line work is 明細単位","xj":"請求書の明細を確認します。","xe":"We check the line items on the invoice.","xf":"請求【せいきゅう】書【しょ】の明細【めいさい】を確認【かくにん】します。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"仕訳連携","r":"しわけれんけい","o":"shiwakerenkei","e":"journal integration / export","n":"Handing generated journals to the external accounting package such as Yayoi","xj":"会計ソフトへ仕訳連携を行います。","xe":"We perform journal export to the accounting software.","xf":"会計【かいけい】ソフトへ仕訳連携【しわけれんけい】を行【おこな】います。","s":"Tier 3 - 仕訳・勘定科目 / Journals & Accounts","se":"Tier 3 - Journals & Accounts"},
        {"j":"顧客","r":"こきゃく","o":"kokyaku","e":"client","n":"The customer entity; the invoice may go to a different party, the 請求先","xj":"新しい顧客からの入金を確認いたします。","xe":"I will confirm the incoming payment from the new client.","xf":"新【あたら】しい顧客【こきゃく】からの入金【にゅうきん】を確認【かくにん】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"請求先","r":"せいきゅうさき","o":"seikyuusaki","e":"bill-to","n":"Who the invoice is addressed to; can differ from whoever ordered the work","xj":"請求先の住所を修正いたします。","xe":"I will correct the bill-to address.","xf":"請求先【せいきゅうさき】の住所【じゅうしょ】を修正【しゅうせい】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"取引先","r":"とりひきさき","o":"torihikisaki","e":"counterparty","n":"Any business partner, customer or supplier; the umbrella word","xj":"この取引先とは長いお付き合いがございます。","xe":"We have a long relationship with this counterparty.","xf":"この取引先【とりひきさき】とは長【なが】いお付【つ】き合【あ】いがございます。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"仕入先","r":"しいれさき","o":"shiiresaki","e":"supplier / seller","n":"The partner we buy from; near-synonym of 発注先","xj":"仕入先への支払を来週行います。","xe":"We will make the payment to the supplier next week.","xf":"仕入先【しいれさき】への支払【しはらい】を来週【らいしゅう】行【おこな】います。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"発注先","r":"はっちゅうさき","o":"hacchuusaki","e":"ordering destination (vendor)","n":"Where a PO is placed; in practice interchangeable with 仕入先","xj":"発注先に見積もりを依頼いたします。","xe":"We will request a quote from the vendor.","xf":"発注先【はっちゅうさき】に見積【みつ】もりを依頼【いらい】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"入金","r":"にゅうきん","o":"nyuukin","e":"incoming payment","n":"Money arriving; matched to open receivables by 消込","xj":"本日、入金がございました。","xe":"There was an incoming payment today.","xf":"本日【ほんじつ】、入金【にゅうきん】がございました。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"支払","r":"しはらい","o":"shiharai","e":"payment (outgoing)","n":"Money going out to suppliers; the AP side","xj":"今月末に支払を済ませます。","xe":"We will complete the outgoing payment at the end of this month.","xf":"今月末【こんげつまつ】に支払【しはらい】を済【す】ませます。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"消込","r":"けしこみ","o":"keshikomi","e":"reconciliation / clearing","n":"Matching payments against open receivables or payables and clearing them; a collection-time step, well after delivery","xj":"入金の消込を行います。","xe":"We will reconcile the incoming payment.","xf":"入金【にゅうきん】の消込【けしこみ】を行【おこな】います。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"部分入金","r":"ぶぶんにゅうきん","o":"bubunnyuukin","e":"partial payment","n":"Payment covering part of an invoice; the rest stays open","xj":"今回は部分入金となっております。","xe":"This time it is a partial payment.","xf":"今回【こんかい】は部分入金【ぶぶんにゅうきん】となっております。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"過入金","r":"かにゅうきん","o":"kanyuukin","e":"overpayment","n":"Customer paid more than billed; held as a deposit until refunded or offset","xj":"過入金の分は返金いたします。","xe":"We will refund the overpayment amount.","xf":"過入金【かにゅうきん】の分【ぶん】は返金【へんきん】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"前受金","r":"まえうけきん","o":"maeukekin","e":"advance received (liability)","n":"Cash received before delivering; a liability until earned","xj":"この金額は前受金として計上します。","xe":"We will record this amount as an advance received.","xf":"この金額【きんがく】は前受金【まえうけきん】として計上【けいじょう】します。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"手形","r":"てがた","o":"tegata","e":"promissory note","n":"Deferred-payment paper still used in JP B2B, cashable at maturity or discounted early; being phased out nationally","xj":"代金は手形で受け取りました。","xe":"We received the payment by promissory note.","xf":"代金【だいきん】は手形【てがた】で受【う】け取【と】りました。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"電子記録債権","r":"でんしきろくさいけん","o":"denshikirokusaiken","e":"electronically recorded claim","n":"Densai, the electronic successor to paper notes, settled through a clearing network","xj":"電子記録債権で決済いたします。","xe":"We will settle by electronically recorded monetary claim.","xf":"電子記録債権【でんしきろくさいけん】で決済【けっさい】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"支払通知書","r":"しはらいつうちしょ","o":"shiharaitsuuchisho","e":"payment notice","n":"The payer's list of what a transfer covers; used to reconcile 入金","xj":"支払通知書を送付いたします。","xe":"We will send the payment notice.","xf":"支払通知書【しはらいつうちしょ】を送付【そうふ】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"源泉徴収","r":"げんせんちょうしゅう","o":"gensenchoushuu","e":"withholding tax","n":"Absent from any accounting context","xj":"報酬から源泉徴収いたします。","xe":"We will apply withholding tax to the remuneration.","xf":"報酬【ほうしゅう】から源泉徴収【げんせんちょうしゅう】いたします。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"振込手数料","r":"ふりこみてすうりょう","o":"furikomitesuuryou","e":"bank transfer fee","n":"JP custom leaves who bears it to negotiation; payers often deduct it, so invoices settle short by a few hundred yen","xj":"振込手数料は当社が負担します。","xe":"Our company will cover the bank transfer fee.","xf":"振込手数料【ふりこみてすうりょう】は当社【とうしゃ】が負担【ふたん】します。","s":"Tier 4 - 取引先・請求・入金 / Parties, Billing, Collection","se":"Tier 4 - Parties, Billing, Collection"},
        {"j":"残高","r":"ざんだか","o":"zandaka","e":"balance","n":"What is still open on an account at a point in time","xj":"今月末の残高を確認いたします。","xe":"I will check the balance as of the end of this month.","xf":"今月末【こんげつまつ】の残高【ざんだか】を確認【かくにん】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"債権","r":"さいけん","o":"saiken","e":"receivable (claim)","n":"Anything owed to us; 売掛金 is the trade subset","xj":"取引先ごとの債権を管理しております。","xe":"We manage receivables by each business partner.","xf":"取引【とりひき】先【さき】ごとの債権【さいけん】を管理【かんり】しております。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"債務","r":"さいむ","o":"saimu","e":"payable (obligation)","n":"Anything we owe; 買掛金 is the trade subset","xj":"支払期日ごとに債務を整理いたします。","xe":"We organize the payables by each due date.","xf":"支払【しはらい】期日【きじつ】ごとに債務【さいむ】を整理【せいり】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"売掛金","r":"うりかけきん","o":"urikakekin","e":"accounts receivable","n":"Trade receivable from credit sales; cleared by 消込 when payment arrives","xj":"売掛金の入金予定を確認いたします。","xe":"I will check the expected collection of accounts receivable.","xf":"売掛金【うりかけきん】の入金【にゅうきん】予定【よてい】を確認【かくにん】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"買掛金","r":"かいかけきん","o":"kaikakekin","e":"accounts payable","n":"Trade payable for credit purchases","xj":"買掛金の支払いは来月に行います。","xe":"We will make the payment of accounts payable next month.","xf":"買掛金【かいかけきん】の支払【しはら】いは来月【らいげつ】に行【おこな】います。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"債権残高","r":"さいけんざんだか","o":"saikenzandaka","e":"AR balance","n":"Open receivables at a date, per customer in the AR ledger","xj":"取引先別の債権残高を照会いたします。","xe":"I will look up the AR balance by business partner.","xf":"取引【とりひき】先【さき】別【べつ】の債権残高【さいけんざんだか】を照会【しょうかい】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"債務残高","r":"さいむざんだか","o":"saimuzandaka","e":"AP balance","n":"Open payables at a date","xj":"月末の債務残高を集計いたします。","xe":"We will total up the AP balance at month-end.","xf":"月末【げつまつ】の債務残高【さいむざんだか】を集計【しゅうけい】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"契約資産","r":"けいやくしさん","o":"keiyakushisan","e":"contract asset","n":"Revenue earned but not yet billable; sits between progress recognition and invoicing under ASBJ No.29","xj":"未請求分は契約資産として計上いたします。","xe":"The unbilled portion is recorded as a contract asset.","xf":"未【み】請求【せいきゅう】分【ぶん】は契約資産【けいやくしさん】として計上【けいじょう】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"前渡金","r":"まえわたしきん","o":"maewatashikin","e":"prepayment (advance paid)","n":"Advance paid to a supplier before delivery; an asset, the mirror of 前受金","xj":"材料の前渡金を先にお支払いします。","xe":"We pay the prepayment for materials in advance.","xf":"材料【ざいりょう】の前渡金【まえわたしきん】を先【さき】にお支払【しはら】いします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"相殺","r":"そうさい","o":"sousai","e":"offset / set-off","n":"Netting a receivable against a payable with the same partner; both sides must book it","xj":"債権と債務を相殺して処理いたします。","xe":"We process it by offsetting the receivable and payable.","xf":"債権【さいけん】と債務【さいむ】を相殺【そうさい】して処理【しょり】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"調整","r":"ちょうせい","o":"chousei","e":"adjustment","n":"A manual correction to make balances agree; each one needs a documented reason","xj":"差額は月末に調整いたします。","xe":"We will make the adjustment for the difference at month-end.","xf":"差額【さがく】は月末【げつまつ】に調整【ちょうせい】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"貸倒","r":"かしだおれ","o":"kashidaore","e":"bad debt","n":"A receivable that will not be collected; written off or provisioned","xj":"回収不能分は貸倒として処理いたします。","xe":"The uncollectible portion is handled as bad debt.","xf":"回収【かいしゅう】不能【ふのう】分【ぶん】は貸倒【かしだおれ】として処理【しょり】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"債権元帳","r":"さいけんもとちょう","o":"saikenmotochou","e":"accounts-receivable ledger","n":"Per-customer ledger of invoices, payments, and the open remainder","xj":"入金は債権元帳に記録いたします。","xe":"Payments received are recorded in the accounts-receivable ledger.","xf":"入金【にゅうきん】は債権元帳【さいけんもとちょう】に記録【きろく】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"過去断面","r":"かこだんめん","o":"kakodanmen","e":"past cross-section","n":"The balances as they stood on a past date, reproducible even after later edits","xj":"過去断面の残高を確認いたします。","xe":"I will check the balance at a past cross-section.","xf":"過去断面【かこだんめん】の残高【ざんだか】を確認【かくにん】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"突合","r":"とつごう","o":"totsugou","e":"matching / reconcile","n":"Comparing two lists to find matches and gaps, e.g. bank statement against books","xj":"入金明細と請求を突合いたします。","xe":"We reconcile the payment details against the invoices.","xf":"入金【にゅうきん】明細【めいさい】と請求【せいきゅう】を突合【とつごう】いたします。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"三点照合","r":"さんてんしょうごう","o":"santenshougou","e":"three-way matching","n":"Matching PO, receipt, and supplier invoice before approving payment","xj":"発注と検収と請求で三点照合を行います。","xe":"We perform three-way matching across the order, receipt, and invoice.","xf":"発注【はっちゅう】と検収【けんしゅう】と請求【せいきゅう】で三点照合【さんてんしょうごう】を行【おこな】います。","s":"Tier 5 - 残高・調整 / Balances & Adjustments","se":"Tier 5 - Balances & Adjustments"},
        {"j":"締め","r":"しめ","o":"shime","e":"closing (period close)","n":"Cutting a period off so its numbers stop moving; the monthly close drives JP billing","xj":"今月の締めは完了しました。","xe":"This month's closing is complete.","xf":"今月【こんげつ】の締【し】めは完了【かんりょう】しました。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"締め日","r":"しめび","o":"shimebi","e":"closing date","n":"Monthly billing cutoff such as the 20th or month-end; deliveries up to it go on one invoice. Not a fiscal period end","xj":"締め日は毎月末日です。","xe":"The closing date is the last day of each month.","xf":"締【し】め日【び】は毎月【まいつき】末日【まつじつ】です。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"会計期間","r":"かいけいきかん","o":"kaikeikikan","e":"accounting period","n":"The reporting period; JP fiscal years commonly run April to March","xj":"この会計期間の売上を確認します。","xe":"I'll check the sales for this accounting period.","xf":"この会計期間【かいけいきかん】の売上【うりあげ】を確認【かくにん】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"月次","r":"げつじ","o":"getsuji","e":"monthly","n":"The monthly close and reporting cycle","xj":"月次の集計を進めています。","xe":"We are working on the monthly aggregation.","xf":"月次【げつじ】の集計【しゅうけい】を進【すす】めています。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"年次","r":"ねんじ","o":"nenji","e":"yearly","n":"The annual cycle feeding 決算","xj":"年次の報告書を準備します。","xe":"We prepare the yearly report.","xf":"年次【ねんじ】の報告【ほうこく】書【しょ】を準備【じゅんび】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"決算","r":"けっさん","o":"kessan","e":"settlement / period-end close","n":"Closing the books for the period; 月次決算 monthly, 本決算 annual","xj":"来週から決算の作業に入ります。","xe":"We start the period-end settlement work next week.","xf":"来週【らいしゅう】から決算【けっさん】の作業【さぎょう】に入【い】ります。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"繰越","r":"くりこし","o":"kurikoshi","e":"carry-over","n":"Carrying a closing balance forward as the next period's opening balance","xj":"前月の繰越を計上します。","xe":"We record the carry-over from last month.","xf":"前月【ぜんげつ】の繰越【くりこし】を計上【けいじょう】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"期首","r":"きしゅ","o":"kishu","e":"start of period","n":"First day of the period; opening balances live here","xj":"期首の残高を登録します。","xe":"We register the balance at the start of the period.","xf":"期首【きしゅ】の残高【ざんだか】を登録【とうろく】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"期末","r":"きまつ","o":"kimatsu","e":"end of period","n":"Last day of the period; closing balances and cut-off checks live here","xj":"期末に在庫を評価します。","xe":"We evaluate inventory at the end of the period.","xf":"期末【きまつ】に在庫【ざいこ】を評価【ひょうか】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"期ずれ","r":"きずれ","o":"kizure","e":"period mismatch","n":"An amount booked in the wrong period; a classic audit finding","xj":"計上の期ずれに注意します。","xe":"We watch out for period mismatch in recording.","xf":"計上【けいじょう】の期【き】ずれに注意【ちゅうい】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"遡及","r":"そきゅう","o":"sokyuu","e":"retroactive","n":"Changing already-closed periods; regenerates downstream balances, so tightly controlled","xj":"先月分まで遡及して修正します。","xe":"We correct it retroactively back to last month.","xf":"先月【せんげつ】分【ぶん】まで遡及【そきゅう】して修正【しゅうせい】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"締め直し","r":"しめなおし","o":"shimenaoshi","e":"re-closing (reopen)","n":"Reopening a closed period to fix and re-close; invalidates documents issued from the first close","xj":"今月は締め直しが発生しました。","xe":"A re-closing occurred this month.","xf":"今月【こんげつ】は締【し】め直【なお】しが発生【はっせい】しました。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"確定","r":"かくてい","o":"kakutei","e":"fix / finalize","n":"Locking figures as final; later changes need a formal correction flow","xj":"数値の確定をお願いします。","xe":"Please finalize the figures.","xf":"数値【すうち】の確定【かくてい】をお願【ねが】いします。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"スナップショット","r":"スナップショット","o":"sunappushotto","e":"snapshot","n":"A value copied at creation so later edits to the source do not rewrite history","xj":"期末のスナップショットを保存します。","xe":"We save the snapshot at period-end.","xf":"期末【きまつ】のスナップショットを保存【ほぞん】します。","s":"Tier 6 - 締め・会計期間 / Closing & Periods","se":"Tier 6 - Closing & Periods"},
        {"j":"収益認識基準","r":"しゅうえきにんしききじゅん","o":"shuuekininshikikijun","e":"revenue recognition standard","n":"ASBJ Statement No.29, JP's IFRS-15 equivalent since FY2021; five steps, recognized per performance obligation","xj":"収益認識基準に従って計上します。","xe":"We record it according to the revenue recognition standard.","xf":"収益認識基準【しゅうえきにんしききじゅん】に従【したが】って計上【けいじょう】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"工事進行基準","r":"こうじしんこうきじゅん","o":"koujishinkoukijun","e":"percentage-of-completion basis","n":"Revenue along construction progress; survives under No.29 as over-time recognition when criteria hold","xj":"この案件は工事進行基準で処理します。","xe":"We process this project on a percentage-of-completion basis.","xf":"この案件【あんけん】は工事進行基準【こうじしんこうきじゅん】で処理【しょり】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"工事完成基準","r":"こうじかんせいきじゅん","o":"koujikanseikijun","e":"completed-contract basis","n":"All revenue at completion and handover; allowed for short or small contracts","xj":"小規模な工事は工事完成基準で計上します。","xe":"Small projects are recorded on a completed-contract basis.","xf":"小【しょう】規模【きぼ】な工事【こうじ】は工事完成基準【こうじかんせいきじゅん】で計上【けいじょう】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"履行義務","r":"りこうぎむ","o":"rikougimu","e":"performance obligation","n":"One distinct promise in the contract; revenue is recognized per obligation, not per invoice","xj":"履行義務を充足した時点で認識します。","xe":"We recognize it when the performance obligation is satisfied.","xf":"履行義務【りこうぎむ】を充足【じゅうそく】した時点【じてん】で認識【にんしき】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"発生主義","r":"はっせいしゅぎ","o":"hasseishugi","e":"accrual basis","n":"Book when the event occurs, not when cash moves; required for corporate books","xj":"費用は発生主義で計上します。","xe":"Expenses are recorded on an accrual basis.","xf":"費用【ひよう】は発生主義【はっせいしゅぎ】で計上【けいじょう】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"現金主義","r":"げんきんしゅぎ","o":"genkinshugi","e":"cash basis","n":"Book when cash moves; generally not acceptable for corporate accounting","xj":"入金は現金主義で記録します。","xe":"Receipts are recorded on a cash basis.","xf":"入金【にゅうきん】は現金主義【げんきんしゅぎ】で記録【きろく】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"消費税","r":"しょうひぜい","o":"shouhizei","e":"consumption tax","n":"Single effective rate of 10 percent, resolved through the shared accounting library","xj":"金額には消費税を加算します。","xe":"We add consumption tax to the amount.","xf":"金額【きんがく】には消費税【しょうひぜい】を加算【かさん】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"税抜","r":"ぜいぬき","o":"zeinuki","e":"tax-exclusive","n":"Stated without consumption tax; internal ledgers usually run tax-exclusive, 税抜経理","xj":"見積金額は税抜で表示します。","xe":"The estimate amount is shown tax-exclusive.","xf":"見積【みつもり】金額【きんがく】は税抜【ぜいぬき】で表示【ひょうじ】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"税込","r":"ぜいこみ","o":"zeikomi","e":"tax-inclusive","n":"Including consumption tax; consumer-facing prices must be shown this way, 総額表示","xj":"請求額は税込で記載します。","xe":"The billed amount is stated tax-inclusive.","xf":"請求【せいきゅう】額【がく】は税込【ぜいこみ】で記載【きさい】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"インボイス制度","r":"インボイスせいど","o":"inboisuseido","e":"invoice system","n":"適格請求書発行事業者登録番号 stored on tenant tax settings; expense lines carry their own","xj":"当社はインボイス制度に対応しています。","xe":"Our company complies with the invoice system.","xf":"当社【とうしゃ】はインボイス制度【せいど】に対応【たいおう】しています。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"適格請求書","r":"てきかくせいきゅうしょ","o":"tekikakuseikyuusho","e":"qualified invoice","n":"Invoice carrying the registration number and per-rate tax totals; without it the buyer loses the input tax credit","xj":"適格請求書を発行いたします。","xe":"We will issue a qualified invoice.","xf":"適格請求書【てきかくせいきゅうしょ】を発行【はっこう】いたします。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"免税事業者","r":"めんぜいじぎょうしゃ","o":"menzeijigyousha","e":"tax-exempt business","n":"Below the taxable-sales threshold, charges no JCT, cannot issue qualified invoices; buying from one costs credit under phasing-out relief","xj":"この取引先は免税事業者です。","xe":"This business partner is a tax-exempt business.","xf":"この取引【とりひき】先【さき】は免税事業者【めんぜいじぎょうしゃ】です。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"仕入税額控除","r":"しいれぜいがくこうじょ","o":"shiirezeigakukoujo","e":"input tax credit","n":"Deducting tax paid on purchases from tax collected on sales; needs qualified invoices since Oct 2023","xj":"この分は仕入税額控除を適用します。","xe":"We apply the input tax credit to this portion.","xf":"この分【ぶん】は仕入税額控除【しいれぜいがくこうじょ】を適用【てきよう】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"電子帳簿保存法","r":"でんしちょうぼほぞんほう","o":"denshichoubohozonhou","e":"e-bookkeeping act","n":"Electronically received documents must be stored electronically with timestamps and search, mandatory since 2024","xj":"保管は電子帳簿保存法に対応します。","xe":"Our storage complies with the Electronic Books Preservation Act.","xf":"保管【ほかん】は電子帳簿保存法【でんしちょうぼほぞんほう】に対応【たいおう】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"建設業法","r":"けんせつぎょうほう","o":"kensetsugyouhou","e":"Construction Business Act","n":"Regulates construction subcontracting, including payment terms and required paperwork","xj":"建設業法に基づいて処理します。","xe":"We handle it in accordance with the Construction Business Act.","xf":"建設業法【けんせつぎょうほう】に基【もと】づいて処理【しょり】します。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"監査","r":"かんさ","o":"kansa","e":"audit","n":"Examination of the books, external or internal","xj":"来月、監査を受けます。","xe":"We will undergo an audit next month.","xf":"来月【らいげつ】、監査【かんさ】を受【う】けます。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"監査証跡","r":"かんさしょうせき","o":"kansashouseki","e":"audit trail","n":"The who-did-what-when record; corrections must preserve it, hence reversal-based fixes","xj":"操作の監査証跡を残しておきます。","xe":"We keep an audit trail of the operations.","xf":"操作【そうさ】の監査証跡【かんさしょうせき】を残【のこ】しておきます。","s":"Tier 7 - 会計基準・税・法 / Standards, Tax, Compliance","se":"Tier 7 - Standards, Tax, Compliance"},
        {"j":"工事原価","r":"こうじげんか","o":"koujigenka","e":"construction cost","n":"All costs attributable to one project, tracked in its 工事台帳","xj":"この案件の工事原価を計算します。","xe":"I will calculate the construction cost for this project.","xf":"この案件【あんけん】の工事原価【こうじげんか】を計算【けいさん】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"未成工事支出金","r":"みせいこうじししゅつきん","o":"miseikoujishishutsukin","e":"construction work-in-process (WIP)","n":"Construction WIP: costs of unfinished projects held as an asset until completion","xj":"まだ完成していない分は未成工事支出金に計上します。","xe":"The unfinished portion is recorded as construction work-in-process.","xf":"まだ完成【かんせい】していない分【ぶん】は未成工事支出金【みせいこうじししゅつきん】に計上【けいじょう】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"完成工事原価","r":"かんせいこうじげんか","o":"kanseikoujigenka","e":"completed-construction cost","n":"Construction's cost of sales; moved out of WIP when the project completes","xj":"引き渡し後に完成工事原価へ振り替えます。","xe":"After handover, we transfer it to completed-construction cost.","xf":"引【ひ】き渡【わた】し後【あと】に完成工事原価【かんせいこうじげんか】へ振【ふ】り替【か】えます。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"工事台帳","r":"こうじだいちょう","o":"koujidaichou","e":"project cost ledger","n":"Per-project cost ledger by element; the source of truth for project profitability","xj":"工事台帳で費用の内訳を確認します。","xe":"I check the cost breakdown in the project cost ledger.","xf":"工事台帳【こうじだいちょう】で費用【ひよう】の内訳【うちわけ】を確認【かくにん】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"材料費","r":"ざいりょうひ","o":"zairyouhi","e":"material cost","n":"Materials consumed; one of the four construction cost elements","xj":"今月は材料費が予算を超えています。","xe":"This month the material cost has exceeded the budget.","xf":"今月【こんげつ】は材料費【ざいりょうひ】が予算【よさん】を超【こ】えています。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"労務費","r":"ろうむひ","o":"roumuhi","e":"labor cost","n":"Own site labor; office salaries are 経費, not 労務費","xj":"作業員の労務費を毎月集計します。","xe":"We total up the workers' labor cost every month.","xf":"作業【さぎょう】員【いん】の労務費【ろうむひ】を毎月【まいつき】集計【しゅうけい】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"外注費","r":"がいちゅうひ","o":"gaichuuhi","e":"subcontract cost","n":"Work bought from subcontractors; usually the largest cost element in JP construction","xj":"下請けへの外注費を計上します。","xe":"We record the subcontract cost paid to the subcontractor.","xf":"下請【したう】けへの外注費【がいちゅうひ】を計上【けいじょう】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"経費","r":"けいひ","o":"keihi","e":"expenses","n":"Project costs outside materials, labor, subcontract: equipment, transport, utilities","xj":"共通の経費を各工事に振り分けます。","xe":"We distribute the shared expenses across each project.","xf":"共通【きょうつう】の経費【けいひ】を各【かく】工事【こうじ】に振【ふ】り分【わ】けます。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"按分","r":"あんぶん","o":"anbun","e":"apportionment","n":"Splitting a shared amount by a ratio: floor area, hours, revenue","xj":"共通費は面積で按分して計上します。","xe":"Common costs are apportioned by floor area and recorded.","xf":"共通【きょうつう】費【ひ】は面積【めんせき】で按分【あんぶん】して計上【けいじょう】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"配賦","r":"はいふ","o":"haifu","e":"cost allocation","n":"Allocating indirect costs onto projects; 按分 is the arithmetic, 配賦 the accounting act","xj":"間接費を各案件に配賦します。","xe":"We allocate the indirect costs to each project.","xf":"間接【かんせつ】費【ひ】を各【かく】案件【あんけん】に配賦【はいふ】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"実績原価","r":"じっせきげんか","o":"jissekigenka","e":"actual cost","n":"Costs actually incurred so far; judged against the 実行予算","xj":"実績原価と予算を比較します。","xe":"We compare the actual cost against the budget.","xf":"実績原価【じっせきげんか】と予算【よさん】を比較【ひかく】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"実行予算","r":"じっこうよさん","o":"jikkouyosan","e":"execution budget","n":"The working budget fixed at project start; profitability is 実行予算 versus 実績原価","xj":"着工前に実行予算を作成します。","xe":"We prepare the execution budget before starting construction.","xf":"着工【ちゃっこう】前【まえ】に実行予算【じっこうよさん】を作成【さくせい】します。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"棚卸","r":"たなおろし","o":"tanaoroshi","e":"stocktaking","n":"Physical count of stock and WIP at period end to true up the books","xj":"月末に資材の棚卸を行います。","xe":"We perform a stocktaking of materials at month-end.","xf":"月末【げつまつ】に資材【しざい】の棚卸【たなおろし】を行【おこな】います。","s":"Tier 8 - 工事原価・在庫 / Construction Cost & Inventory","se":"Tier 8 - Construction Cost & Inventory"},
        {"j":"紐づく","r":"ひもづく","o":"himozuku","e":"be linked to","n":"Everyday word for \"is linked to\"; a foreign-key relation in requirements talk","xj":"この費用は工事案件に紐づく形で管理します。","xe":"This cost is managed in a way that is linked to the construction project.","xf":"この費用【ひよう】は工事【こうじ】案件【あんけん】に紐【ひも】づく形【かたち】で管理【かんり】します。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"起点","r":"きてん","o":"kiten","e":"origin / starting point","n":"What a flow starts from, e.g. which document a journal is generated from","xj":"受注が売上計上の起点になります。","xe":"The order becomes the starting point for revenue recognition.","xf":"受注【じゅちゅう】が売上【うりあげ】計上【けいじょう】の起点【きてん】になります。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"独立","r":"どくりつ","o":"dokuritsu","e":"independent","n":"Standing alone, not derived from another record","xj":"各現場の予算は独立して管理します。","xe":"Each site's budget is managed independently.","xf":"各【かく】現場【げんば】の予算【よさん】は独立【どくりつ】して管理【かんり】します。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"明細単位","r":"めいさいたんい","o":"meisaitani","e":"per line item","n":"Per line item rather than per document; rounding and recognition often hinge on this","xj":"請求書は明細単位で確認します。","xe":"We check the invoice per line item.","xf":"請求【せいきゅう】書【しょ】は明細単位【めいさいたんい】で確認【かくにん】します。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"二重計上","r":"にじゅうけいじょう","o":"nijuukeijou","e":"double recognition","n":"The same amount booked twice; what duplicate triggers produce","xj":"経費の二重計上にご注意ください。","xe":"Please be careful of double recognition of expenses.","xf":"経費【けいひ】の二重計上【にじゅうけいじょう】にご注意【ちゅうい】ください。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"計上漏れ","r":"けいじょうもれ","o":"keijoumore","e":"missed recognition","n":"An amount never booked; the opposite failure of 二重計上","xj":"今月の計上漏れがないか確認します。","xe":"We check whether there is any missed recognition this month.","xf":"今月【こんげつ】の計上漏【けいじょうも】れがないか確認【かくにん】します。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"月跨ぎ","r":"つきまたぎ","o":"tsukimatagi","e":"crossing months (period spanning)","n":"Work or delivery spanning a month boundary; forces the which-period decision","xj":"この取引は月跨ぎになります。","xe":"This transaction spans across months.","xf":"この取引【とりひき】は月跨【つきまた】ぎになります。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"洗い出し","r":"あらいだし","o":"araidashi","e":"enumeration / identification","n":"Exhaustively listing every case before deciding; standard JP meeting verb","xj":"対象となる費用の洗い出しを行います。","xe":"We carry out an enumeration of the applicable costs.","xf":"対象【たいしょう】となる費用【ひよう】の洗【あら】い出【だ】しを行【おこな】います。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"認識合わせ","r":"にんしきあわせ","o":"ninshikiawase","e":"getting aligned","n":"Agreeing a shared understanding first; a meeting phrase, not an accounting term","xj":"経理と認識合わせをしておきます。","xe":"I will get aligned with accounting beforehand.","xf":"経理【けいり】と認識合【にんしきあ】わせをしておきます。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"仮計上","r":"かりけいじょう","o":"karikeijou","e":"provisional recognition","n":"Booking a provisional figure to hold the period, corrected when the real one arrives","xj":"金額が未確定なので仮計上します。","xe":"Since the amount is not yet finalized, we record it as a provisional recognition.","xf":"金額【きんがく】が未【み】確定【かくてい】なので仮計上【かりけいじょう】します。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"本社一括","r":"ほんしゃいっかつ","o":"honshaikkatsu","e":"headquarters-consolidated","n":"Handled centrally at head office rather than per site, e.g. one consolidated payment","xj":"支払いは本社一括で行います。","xe":"Payments are made consolidated at headquarters.","xf":"支払【しはら】いは本社一括【ほんしゃいっかつ】で行【おこな】います。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"対応付け","r":"たいおうづけ","o":"taiouzuke","e":"mapping / association","n":"Establishing which record corresponds to which","xj":"入金と請求の対応付けを確認します。","xe":"We check the mapping between payments and invoices.","xf":"入金【にゅうきん】と請求【せいきゅう】の対応付【たいおうづ】けを確認【かくにん】します。","s":"Tier 9 - 議論フレーズ / Discussion","se":"Tier 9 - Discussion"},
        {"j":"受注ヘッダー","r":"じゅちゅうヘッダー","o":"juchuuhedda","e":"order header","n":"Order-level record: who ordered, when, for how much, on what terms. Carries no tax code","s":"Epic-01 defined terms","se":"Epic-01 defined terms"},
        {"j":"受注明細","r":"じゅちゅうめいさい","o":"juchuumeisai","e":"order line","n":"The unit carrying quantity, unit price, tax code, and later its own delivery status","s":"Epic-01 defined terms","se":"Epic-01 defined terms"},
        {"j":"役務提供状況","r":"えきむていきょうじょうきょう","o":"ekimuteikyoujoukyou","e":"service delivery status","n":"How far along delivery of one line is. Scoped to Epic-01-b","s":"Epic-01 defined terms","se":"Epic-01 defined terms"},
        {"j":"役務完了","r":"えきむかんりょう","o":"ekimukanryou","e":"service completion","n":"The supplier finishing the work. Distinct from and earlier than acceptance","s":"Epic-01 defined terms","se":"Epic-01 defined terms"},
        {"j":"受注残リスト","r":"じゅちゅうざんリスト","o":"juchuuzanrisuto","e":"order backlog list","n":"Order lines ordered and not yet left the backlog","s":"Epic-01 defined terms","se":"Epic-01 defined terms"},
        {"j":"受注残高","r":"じゅちゅうざんだか","o":"juchuuzandaka","e":"order backlog amount","n":"The money total of that list","s":"Epic-01 defined terms","se":"Epic-01 defined terms"},
        {"j":"受注番号","e":"order number","n":"Copied from the job's management number with an Exx suffix","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"仕事","e":"job","n":"Required. An order cannot exist without one","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"顧客の区分","e":"is company","n":"Snapshot, fixed at creation","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"顧客名","e":"customer name","n":"Snapshot","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"担当者名","e":"contact name","n":"Snapshot","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"宛名","e":"addressee","n":"Snapshot","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"敬称","e":"honorific","n":"Snapshot","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"住所","e":"address","n":"Snapshot","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"受注日","e":"order date","n":"Defaults to the date the trigger fired. Editable","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"受注金額","e":"order amount","n":"Calculated from the lines. Not directly editable","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"通貨","e":"currency","n":"Copied from the invoice","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"納期","e":"delivery date","n":"Free","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"検収条件","e":"acceptance terms","n":"Free text. Drives nothing in Epic-01","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"アーカイブ状態","e":"archive state","n":"The single status field, after order state was folded into it","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"備考","e":"notes","n":"Free - Free","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"カスタム項目","e":"custom fields","n":"Configured by US-11 - Configured by US-11","s":"Order header fields (受注ヘッダー)","se":"Order header fields"},
        {"j":"行タイプ","e":"line type","n":"group, detail, or text-only. Text-only lines carry no money","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"親行","e":"parent line","n":"Set on a detail line under a group line","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"並び順","e":"sort order","n":"Display order within the order","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"品名","e":"item name","n":"Free","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"数量","e":"quantity","n":"Free","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"単位","e":"unit","n":"Free","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"単価","e":"unit price","n":"Free","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"原価","e":"cost","n":"Free. Not used for recognition in Epic-01","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"金額","e":"amount","n":"Quantity times unit price, less discount","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"税区分","e":"tax code","n":"Per line. Totals grouped by tax code, which is why the header has none - Per-tenant tax-code map in tax settings is the authoritative list","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"型番","e":"model number","n":"Free","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"定価単価","e":"list price","n":"Stored but not read in Phase 1","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"値引き","e":"discount","n":"Used in Phase 1","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"検収進捗","e":"acceptance progress","n":"Epic-01-b","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"役務完了日","e":"service completion date","n":"Epic-01-b","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"検収完了日","e":"acceptance date","n":"Epic-01-b","s":"Order line fields (受注明細)","se":"Order line fields"},
        {"j":"借方 / 貸方","e":"debit / credit","n":"Default debit and credit accounts for sales and cost configured per tenant","s":"Japanese accounting machinery as implemented","se":"Japanese accounting machinery as implemented"},
        {"j":"端数処理","r":"はすうしょり","o":"hasuushori","e":"rounding","n":"Per-tenant rounding type and digit count, snapshot-copied onto each document at creation","s":"Japanese accounting machinery as implemented","se":"Japanese accounting machinery as implemented"},
        {"j":"弥生","e":"Yayoi export","n":"One of four export formats, with Money Forward and two Kanjo Bugyo variants. Export only","s":"Japanese accounting machinery as implemented","se":"Japanese accounting machinery as implemented"},
        {"j":"予算 / 実績","e":"budget vs actual","n":"Planned costs plus the balances module. No single module named for it","s":"Japanese accounting machinery as implemented","se":"Japanese accounting machinery as implemented"},
        {"j":"収支管理","e":"profit and loss","n":"The balances module, per job","s":"Japanese accounting machinery as implemented","se":"Japanese accounting machinery as implemented"},
        {"j":"四捨五入","r":"しごにゅう","o":"shigonyuu","e":"round half up","n":"0-4 down, 5-9 up; the business picks one method but applies it once per tax-rate group per invoice","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"切上げ","r":"きりあげ","o":"kiriage","e":"round up","n":"Always round up; rare for tax, seen in fee schedules","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"切り捨て","r":"きりすて","o":"kirisute","e":"round down","n":"Always drop the fraction; the most common JP choice for consumption tax amounts","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"小計","r":"しょうけい","o":"shoukei","e":"subtotal","n":"Per-group total before tax; qualified invoices compute tax on per-rate subtotals","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"合計","r":"ごうけい","o":"goukei","e":"total","n":"Grand total after tax","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"差分","r":"さぶん","o":"sabun","e":"difference / diff","n":"The difference between two computations, here invoice total versus sum of lines","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"再配布","r":"さいはいふ","o":"saihaifu","e":"redistribution (of the rounding remainder across items)","n":"Spreading an invoice-level rounding difference back across lines so they sum exactly","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"課税売上","r":"かぜいうりあげ","o":"kazeiuriage","e":"taxable sales (prefix on tax codes, e.g. 課税売上10%)","n":"Sales subject to consumption tax, unlike 非課税 and 不課税; the code prefix carries the rate","s":"Rounding and diff vocabulary","se":"Rounding and diff vocabulary"},
        {"j":"会計年度","e":"fiscal year","n":"No module, no schema field","s":"Not implemented","se":"Not implemented"},
    ];
    /* END GENERATED TERMS */

    // Temporary: diagnosing why send-to-chat does not reach the composer. Strip before
    // committing once the cause is known.
    // Kept in memory as well as logged. A send that fails during a live call is not a moment
    // for opening devtools, so the panel can show its own trace instead.
    const TRACE = [];
    const traceT0 = Date.now();
    const dbg = (m) => {
        TRACE.push('+' + String(Date.now() - traceT0).padStart(5) + 'ms  ' + m);
        if (TRACE.length > 60) TRACE.shift();
        if (DEBUG) console.log('[Kaikei]', m);
    };

    const CHAT_IFRAME = 'iframe[src*="chat.google.com"]';
    const CHAT_TOGGLE = 'button[data-panel-id="2"]';
    const CHAT_PANEL = 'div[data-panel-id="2"]';
    // Chat already open: the composer exists, so an ack should be quick.
    const ACK_TIMEOUT_MS = 12000;
    // Cold open is slow: toggle click, then the iframe element, then the Chat app, then the
    // Lexical editor. Split across two attempts rather than one long one, so a cold send that
    // needs a second try still finishes inside the same wait a single attempt would have cost.
    const COLD_TIMEOUT_MS = 12000;
    const RETRY_TIMEOUT_MS = 8000;
    // The agent says hello the moment it loads. A frame that has existed this long without
    // one is a frame the script is not running in, which no amount of waiting fixes.
    const SILENT_FRAME_MS = 5000;
    // Gmeet++ waits up to 8s for the composer itself, so give its whole handshake room.
    const GMPP_TIMEOUT_MS = 10000;

    const MAX_RESULTS = 12;

    // ---------------------------------------------------------------- searching

    // Kana are searched as typed; no romaji transliteration. Matching is substring on
    // every field so "receivable", "うりかけ" and "売掛" all reach 売掛金.
    const norm = (s) => (s || '').toLowerCase().normalize('NFKC');

    // Search always covers every field in both languages, whatever the display mode is. A
    // reader in EN mode still needs to find a term someone just said in Japanese.
    const HAYSTACK = TERMS.map((t) => ({
        t,
        hay: norm([t.j, t.r, t.o, t.e, t.n, t.xj, t.xe, t.s, t.se].join(' ')),
        head: norm([t.j, t.r, t.o, t.e].join(' ')),
    }));

    function search(query) {
        const q = norm(query.trim());
        if (!q) return [];
        const tokens = q.split(/\s+/);
        const hits = [];
        for (const row of HAYSTACK) {
            if (!tokens.every((tok) => row.hay.includes(tok))) continue;
            // Rank: exact term > term prefix > any headline field > note/section only.
            let score = 3;
            if (row.t.j === query.trim() || norm(row.t.e) === q) score = 0;
            else if (norm(row.t.j).startsWith(q) || norm(row.t.e).startsWith(q)) score = 1;
            else if (row.head.includes(q)) score = 2;
            hits.push({ row, score });
        }
        hits.sort((a, b) => a.score - b.score || a.row.t.j.length - b.row.t.j.length);
        return hits.slice(0, MAX_RESULTS).map((h) => h.row.t);
    }

    // ------------------------------------------------------------- chat sending

    // Meet's own chat composer, living in the Meet document. Newer builds render chat in the
    // page instead of a chat.google.com iframe, so there is no frame to bridge to and the
    // second @match never loads anywhere - which reports "no agent" no matter how long you
    // wait, because nothing is missing except the frame we assumed existed. This is the same
    // same-origin shape the Gemini path already uses successfully in this document.
    //
    // Only an old textarea was recognised before, so an in-page chat looked like no chat.
    function nativeChatBox() {
        const cands = [];
        const panel = document.querySelector(CHAT_PANEL);
        if (panel) cands.push(...panel.querySelectorAll('textarea, [contenteditable="true"]'));
        for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
            const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '');
            if (/メッセージ|全員|message/i.test(label)) cands.push(el);
        }
        for (const el of cands) {
            // The Gemini composer is also a same-origin contenteditable in this document.
            // Posting a chat line into it would ask Gemini the question instead of telling
            // the room the answer.
            if (/gemini/i.test(el.getAttribute('aria-label') || '')) continue;
            if (el.getAttribute('role') === 'combobox') continue;
            if (el.closest('#kaikei-panel')) continue;
            return el;
        }
        return null;
    }

    // The send button's identity varies by Meet build: a labelled button, a button whose
    // tooltip carries the label, or an icon-only button whose ONLY identity is the material
    // icon ligature "send" rendered as its text. Look for every signal, walking outward from
    // the composer so a match beside the box always beats a match across the page.
    function nativeChatSendBtn(box) {
        const geminiScope = geminiBox()?.closest('[jscontroller]');
        const looksLikeSend = (b) => {
            if (b.closest('#kaikei-panel') || b.closest('#kaikei-trace')) return false;
            if (geminiScope && geminiScope.contains(b)) return false; // Gemini's own send
            if (b.getAttribute('jsname') === 'LgbsSe') return false;
            const label = [
                b.getAttribute('aria-label'), b.getAttribute('data-tooltip'), b.getAttribute('title'),
            ].filter(Boolean).join(' ');
            if (/送信|send/i.test(label)) return true;
            if (b.getAttribute('jsname') === 'SoqoBf') return true; // Meet's chat send button
            if (b.type === 'submit') return true;
            // Icon-only: the icon font draws the glyph from the ligature text "send".
            for (const icon of b.querySelectorAll('i, span')) {
                if (icon.textContent.trim().toLowerCase() === 'send') return true;
            }
            return false;
        };
        let scope = box.parentElement;
        while (scope && scope !== document.body) {
            const hit = [...scope.querySelectorAll('button')].find(looksLikeSend);
            if (hit) return hit;
            scope = scope.parentElement;
        }
        return [...document.querySelectorAll('button')].find(looksLikeSend) || null;
    }

    // Resolves true only once the line is confirmed gone from the composer.
    async function nativeSend(text, timeoutMs) {
        const box = nativeChatBox();
        if (!box) return false;
        dbg('native composer: ' + (box.tagName + ' ' + (box.getAttribute('aria-label') || '')).trim());
        const ins = await composerInsert(box, text, Math.min(8000, timeoutMs));
        if (!ins.ok) { dbg('native composer would not take the text'); return false; }
        // Most of the budget goes to the button, but never all of it: the Enter fallback
        // below needs its turn while the text is still sitting in the box.
        const btnBudget = Math.max(3000, Math.floor(timeoutMs * 0.6));
        if (await sendAndVerify(box, () => nativeChatSendBtn(box), btnBudget, 'native')) return true;
        // No clickable button did the job. Meet's own composer also submits on Enter, and
        // unlike Google Chat's Lexical editor it acts on the keydown without checking
        // isTrusted. Synthetic keydown never types anything by itself, so this is free when
        // ignored - and it is judged by the box emptying, never assumed.
        dbg('native: no send button worked, trying Enter');
        for (let round = 0; round < 3; round++) {
            box.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) {
                box.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                    bubbles: true, cancelable: true,
                }));
            }
            for (let i = 0; i < 10; i++) {
                if (!boxText(box).trim()) { dbg('native: Enter sent it'); return true; }
                await after(150);
            }
        }
        dbg('native: Enter did not send either, text still in the box');
        return false;
    }

    // 'open' | 'opening' | 'closed' | 'unknown'.
    //
    // Only a live frame counts as open. Meet flips aria-expanded when the animation STARTS,
    // so trusting that attribute means treating a panel with no frame in it as ready to
    // receive - which takes the fast single-attempt path and misses. That state gets its own
    // name so it can be handled like a cold open without clicking the toggle again, since
    // clicking it there would close the panel.
    function chatState() {
        if (document.querySelector(CHAT_IFRAME)) return 'open';
        const toggle = document.querySelector(CHAT_TOGGLE);
        if (!toggle) return 'unknown';
        const v = toggle.getAttribute('aria-expanded') ?? toggle.getAttribute('aria-pressed');
        return v === 'true' ? 'opening' : v === 'false' ? 'closed' : 'unknown';
    }

    function openChat() {
        const toggle = document.querySelector(CHAT_TOGGLE);
        if (toggle) toggle.click();
        return Boolean(toggle);
    }

    const after = (ms) => new Promise((r) => setTimeout(r, ms));

    // The in-frame half announces itself on load, and its diagnostics count as proof of life
    // too. This separates "the script is not running in the chat frame" (reinstall) from "the
    // composer would not take the text" (a Chat problem) instead of reporting one timeout for
    // both. Registered once, for the lifetime of the page, not per send.
    let agentSeen = false;
    window.addEventListener('message', (e) => {
        if (e.origin !== CHAT_ORIGIN) return;
        const d = e.data;
        if (!d || d.kaikei !== KAIKEI_TOKEN) return;
        if (d.type === 'hello' || d.type === 'diag') {
            if (!agentSeen) { agentSeen = true; dbg('chat agent is alive'); }
            if (d.type === 'diag') dbg('frame: ' + d.msg);
        }
    });

    // Ask the in-frame agent whether its composer exists yet, and keep asking until it says
    // so. Three separate things have to happen after the toggle click - the iframe element,
    // the Chat app inside it, then the Lexical editor - and only the agent inside the frame
    // can see the last one. Resolves 'ready' | 'no-frame' | 'no-agent' | 'no-composer'.
    function waitForChatReady(withinMs) {
        return new Promise((resolve) => {
            const started = Date.now();
            let pongSeen = false;
            let frameSeen = false;
            let done = false;
            const finish = (r) => {
                if (done) return;
                done = true;
                window.removeEventListener('message', onPong);
                clearInterval(poll);
                dbg('readiness: ' + r + ' after ' + (Date.now() - started) + 'ms');
                resolve(r);
            };
            const onPong = (e) => {
                if (e.origin !== CHAT_ORIGIN) return;
                const d = e.data;
                if (!d || d.kaikei !== KAIKEI_TOKEN || d.type !== 'pong') return;
                pongSeen = true;
                if (d.ready) finish('ready');
            };
            window.addEventListener('message', onPong);
            const ping = () => {
                const frames = document.querySelectorAll(CHAT_IFRAME);
                if (frames.length) frameSeen = true;
                // Chat rendered in the page has no frame to wait for, so the composer
                // turning up IS the ready signal. Without this the send sits out the whole
                // frame timeout first and lands twelve seconds late.
                if (!frameSeen && nativeChatBox()) { finish('native'); return; }
                for (const f of frames) {
                    try {
                        f.contentWindow?.postMessage(
                            { kaikei: KAIKEI_TOKEN, type: 'ping', id: 'ready' }, CHAT_ORIGIN,
                        );
                    } catch (err) { /* a frame mid-navigation */ }
                }
                if (Date.now() - started > withinMs) {
                    finish(!frameSeen ? 'no-frame' : pongSeen ? 'no-composer' : 'no-agent');
                }
            };
            ping();
            const poll = setInterval(ping, 150);
        });
    }

    // Open the chat panel if it is closed, then hand off to the retrying bridge.
    // Resolves 'sent' | 'manual' | 'failed' | 'timeout' | 'no-agent'.
    //
    // `onStage` gets a short label for the button so a cold open does not look like a dead
    // click for twenty seconds.
    async function postToChat(text, onStage) {
        if (await nativeSend(text, 8000)) { dbg('sent through the in-page composer'); return 'sent'; }

        const before = chatState();
        dbg('postToChat chat=' + before + ' agentSeen=' + agentSeen);
        if (before === 'closed') {
            // The frame only exists once chat is open. bridgeSend re-queries every tick, so
            // clicking here and posting immediately is safe.
            const clicked = openChat();
            dbg('opened chat panel: ' + clicked);
            onStage(clicked ? 'Opening chat...' : 'Open chat first');
            if (!clicked) return 'no-toggle';
        } else if (before === 'open') {
            onStage('Sending...');
        } else {
            // Mid-animation or no toggle to read. Do NOT click - that would close a panel
            // already on its way open.
            onStage('Opening chat...');
        }

        // The second click was never doing anything clever - it was arriving late enough that
        // the composer existed. So wait for that moment explicitly and then send once, rather
        // than racing three optimistic sends at a frame that may not be there yet. A send
        // fired before the composer mounts is not slow, it is lost, and no number of parallel
        // attempts fixes that; asking does.
        const ready = await waitForChatReady(before === 'open' ? ACK_TIMEOUT_MS : COLD_TIMEOUT_MS);
        // The panel finished opening while we waited. If chat lives in the page rather than
        // in a frame, the composer only exists now, so this is the real attempt, not a retry.
        if (ready === 'native' || ready === 'no-frame') {
            onStage('Sending...');
            if (await nativeSend(text, 12000)) { dbg('sent through the in-page composer'); return 'sent'; }
        }
        let res;
        if (ready === 'no-frame') {
            res = 'timeout';
        } else if (ready === 'no-agent') {
            res = 'no-agent';
        } else {
            // 'no-composer' means the agent is answering but never saw an editor. Send anyway:
            // bridgeSend waits for the composer on the far side too, and one message is cheap.
            onStage('Sending...');
            res = await bridgeSend(text, ready === 'ready' ? ACK_TIMEOUT_MS : RETRY_TIMEOUT_MS);
        }

        // Nothing ever answered from inside the frame, across both attempts.
        if (res === 'timeout' && !agentSeen) res = 'no-agent';

        // Last resort: Gmeet++ ships its own agent into the same frame and the captain uses
        // it daily, so when ours cannot be reached its bridge is a live path that already
        // works on this machine. Speaking its protocol costs one message and no coupling
        // beyond the wire format; if it is not installed, nothing answers and we fall
        // through unchanged.
        if (res !== 'sent' && res !== 'manual') {
            dbg('own bridge returned ' + res + ', trying the Gmeet++ agent');
            onStage('Trying Gmeet++...');
            const alt = await gmppSend(text);
            if (alt !== 'absent') { dbg('Gmeet++ bridge: ' + alt); return alt; }
        }
        return res;
    }

    // Gmeet++'s in-frame agent contract. These constants must match that script exactly.
    const GMPP_TOKEN = 'gmpp-bridge-1';

    // Resolves 'sent' | 'manual' | 'failed' | 'absent'.
    function gmppSend(text) {
        const id = 'kaikei-via-gmpp-' + Date.now();
        return new Promise((resolve) => {
            let done = false;
            const finish = (r) => {
                if (done) return;
                done = true;
                window.removeEventListener('message', onAck);
                clearInterval(poll);
                clearTimeout(timer);
                resolve(r);
            };
            const onAck = (e) => {
                if (e.origin !== CHAT_ORIGIN) return;
                const d = e.data;
                if (!d || d.gmpp !== GMPP_TOKEN || d.type !== 'send-ack' || d.id !== id) return;
                finish(d.ok ? (d.manual ? 'manual' : 'sent') : 'failed');
            };
            window.addEventListener('message', onAck);
            const post = () => {
                for (const f of document.querySelectorAll(CHAT_IFRAME)) {
                    try {
                        f.focus();
                        f.contentWindow?.postMessage({ gmpp: GMPP_TOKEN, type: 'send', id, text }, CHAT_ORIGIN);
                    } catch (err) { /* ignore */ }
                }
            };
            post();
            const poll = setInterval(post, 250);
            const timer = setTimeout(() => finish('absent'), GMPP_TIMEOUT_MS);
        });
    }

    // Re-query the iframe and re-post until the in-frame agent acks. One shared id, deduped
    // on the other side, so the retries never produce two messages.
    function bridgeSend(text, timeoutMs) {
        const id = 'kaikei-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        return new Promise((resolve) => {
            let done = false;
            const finish = (r) => {
                if (done) return;
                done = true;
                window.removeEventListener('message', onAck);
                clearInterval(poll);
                clearTimeout(timer);
                dbg('attempt result: ' + r);
                resolve(r);
            };
            const onAck = (e) => {
                if (e.origin !== CHAT_ORIGIN) return;
                const d = e.data;
                if (!d || d.kaikei !== KAIKEI_TOKEN || d.type !== 'send-ack' || d.id !== id) return;
                finish(d.status);
            };
            window.addEventListener('message', onAck);

            let ticks = 0;
            let frameSince = 0;
            const post = () => {
                ticks += 1;
                // Post to EVERY matching frame, not the first. Meet can hold more than one
                // chat.google.com iframe at a time (a stale one from a previous open, or a
                // pre-warm), and querySelector would keep addressing the wrong one forever.
                const frames = document.querySelectorAll(CHAT_IFRAME);
                if (frames.length && !frameSince) {
                    frameSince = Date.now();
                    dbg('iframe(s) present after ~' + (ticks * 250) + 'ms, count=' + frames.length);
                }
                for (const f of frames) {
                    try {
                        // Hand the browser's focus to the frame. Without this the insert runs
                        // in a frame that is not focused and silently writes nothing, which is
                        // what made the first click look dead and the second one work.
                        f.focus();
                        f.contentWindow?.focus();
                        f.contentWindow?.postMessage({ kaikei: KAIKEI_TOKEN, type: 'send', id, text }, CHAT_ORIGIN);
                    } catch (err) { /* a frame mid-navigation */ }
                }
                // A frame that has been up this long with nothing answering is not a slow
                // composer, it is no script inside the frame. Say so now instead of burning
                // the full timeout on a wait that cannot succeed.
                if (frameSince && !agentSeen && Date.now() - frameSince > SILENT_FRAME_MS) {
                    dbg('frame up ' + SILENT_FRAME_MS + 'ms with no agent hello');
                    finish('no-agent');
                }
            };
            post();
            const poll = setInterval(post, 250);
            const timer = setTimeout(() => {
                dbg('timeout after ' + timeoutMs + 'ms, frameSeen=' + Boolean(frameSince) + ' agentSeen=' + agentSeen);
                finish('timeout');
            }, timeoutMs);
        });
    }

    // navigator.clipboard.writeText needs TRANSIENT USER ACTIVATION. Any await before it -
    // and the chat handshake can take 9 seconds - lets that activation expire, so the write
    // rejects and the user gets nothing. Every caller must therefore copy synchronously
    // inside the click handler, before awaiting anything.
    function copy(text) {
        // navigator.clipboard is absent entirely outside a secure context. Reading .writeText
        // off undefined throws synchronously and takes the whole click handler with it, so
        // this must be guarded rather than only .catch()ed.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(() => true, (err) => {
                dbg('clipboard API rejected: ' + err);
                return Promise.resolve(legacyCopy(text));
            });
        }
        dbg('no clipboard API, using execCommand');
        return Promise.resolve(legacyCopy(text));
    }

    // Synchronous fallback. Works without a secure context and without the async permission.
    function legacyCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { dbg('execCommand threw: ' + e); }
        ta.remove();
        return ok;
    }

    // ------------------------------------------------------------------ speech

    // Browser TTS via the Web Speech API. No network, no key, no audio files. Output goes to
    // the listener's OWN speakers - it is NOT injected into the call - so every colleague who
    // wants to hear a term needs the script installed themselves.
    const TTS = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    let voices = [];

    if (TTS) {
        voices = TTS.getVoices() || [];
        // getVoices() is empty until the engine populates it, asynchronously on most engines.
        TTS.addEventListener('voiceschanged', () => {
            voices = TTS.getVoices() || [];
            dbg('voices loaded: ' + voices.length + ', ja=' + voicesFor('ja').map((v) => v.name).join('/'));
            refreshSpeakButtons();
            buildVoiceNotice();
        });
    }

    // macOS ships eleven ja-JP voices, but eight of them are the cross-language novelty family
    // (Eddy, Grandma, Rocko and friends) which read Japanese as a cartoon. Picking the first
    // ja-* match landed on Eddy. Only three are real Japanese voices, and Hattori is the one
    // that was actually listened to and chosen.
    // English is the male voice the alphabetical sort happened to land on before the novelty
    // filter existed, kept deliberately now. The rest are the male fallbacks on other
    // platforms, then any real voice.
    const PREFERRED = {
        ja: ['Hattori', 'O-Ren', 'Kyoko', 'Otoya'],
        en: [
            'Aaron',
            'Daniel (English (United Kingdom))',
            'Daniel',
            'Microsoft David - English (United States)',
            'Google US English',
            'Samantha',
        ],
    };

    // Same family, every language. Suffixed variants like "Eddy (Japanese (Japan))" match on
    // the leading name.
    const NOVELTY = [
        'eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley',
        'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'fred',
        'good news', 'jester', 'junior', 'kathy', 'organ', 'ralph', 'superstar',
        'trinoids', 'whisper', 'wobble', 'zarvox',
    ];
    const isNovelty = (v) => {
        const n = v.name.toLowerCase();
        return NOVELTY.some((x) => n === x || n.startsWith(x + ' ('));
    };

    function voicesFor(prefix) {
        const all = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix));
        // Only fall back to the novelty voices if a platform has literally nothing else.
        const usable = all.filter((v) => !isNovelty(v));
        const list = usable.length ? usable : all;
        const pref = PREFERRED[prefix] || [];
        const rank = (v) => {
            const i = pref.indexOf(v.name);
            return i === -1 ? pref.length : i;
        };
        return list.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    }

    // Pick a voice whose lang matches. Without this the engine reads 受注 with an English
    // voice, which produces noise rather than a pronunciation.
    function voiceFor(prefix) {
        return voicesFor(prefix)[0] || null;
    }

    // Before the voice list arrives we cannot know, so assume available rather than showing
    // every button disabled on load.
    const hasVoice = (prefix) => Boolean(TTS) && (!voices.length || Boolean(voiceFor(prefix)));

    function speak(text, prefix, fallbackLang) {
        if (!TTS || !text) return;
        try {
            TTS.cancel(); // never stack utterances on a rapid second click
            const u = new SpeechSynthesisUtterance(text);
            const v = voiceFor(prefix);
            if (v) u.voice = v;
            u.lang = v ? v.lang : fallbackLang;
            if (prefix === 'ja') u.rate = 0.9; // full rate is hard to catch for a learner
            TTS.speak(u);
        } catch (e) {
            dbg('speak failed: ' + e);
        }
    }

    // Speak buttons are created before the voice list exists, so they are re-labelled once
    // 'voiceschanged' fires.
    const speakButtons = new Set();
    function refreshSpeakButtons() {
        for (const { btn, prefix } of speakButtons) {
            const ok = hasVoice(prefix);
            btn.disabled = !ok;
            btn.title = ok
                ? 'Play through your own speakers'
                : `No ${prefix === 'ja' ? 'Japanese' : 'English'} voice installed in this browser`;
        }
    }

    // ---------------------------------------------------------------- furigana

    // Turn the deck's 漢字【かな】 notation into <ruby>. The bracket annotates the run of CJK
    // ideographs immediately before it, so お送【おく】り renders as お + 送(おく) + り, not
    // お送(おく)り - the leading kana is already readable and must stay outside the ruby.
    const KANJI_RUN = /([一-鿿々〆々]+)【([^】]+)】/g;

    function appendFurigana(parent, annotated) {
        let last = 0;
        let m;
        KANJI_RUN.lastIndex = 0;
        while ((m = KANJI_RUN.exec(annotated)) !== null) {
            if (m.index > last) parent.append(annotated.slice(last, m.index));
            const ruby = document.createElement('ruby');
            ruby.append(m[1]);
            const rt = document.createElement('rt');
            rt.textContent = m[2];
            ruby.appendChild(rt);
            parent.appendChild(ruby);
            last = m.index + m[0].length;
        }
        if (last < annotated.length) parent.append(annotated.slice(last));
        return last > 0; // false means nothing was annotated
    }

    // Japanese and English are ALWAYS both shown, side by side. The room holds English-only
    // speakers, Japanese-only speakers, and learners at every point between; hiding either
    // language only moves the problem onto someone else.
    //
    // What IS optional is the two reading aids, independently, because they serve opposite
    // people. Furigana helps someone who reads kana but not this kanji. Romaji helps someone
    // who reads neither - and is patronising to someone who reads both, which is precisely
    // the person most likely to resent it.
    const AIDS = [
        { key: 'furigana', label: 'ふりがな', title: 'Kana above the kanji', def: true },
        { key: 'romaji', label: 'Romaji', title: 'Latin-alphabet reading beside the term', def: true },
    ];
    const aid = {};
    for (const a of AIDS) {
        let v = null;
        try { v = localStorage.getItem('kaikei-meet-' + a.key); } catch (e) { /* blocked */ }
        aid[a.key] = v === null ? a.def : v === '1';
    }
    function setAid(key, on) {
        aid[key] = on;
        try { localStorage.setItem('kaikei-meet-' + key, on ? '1' : '0'); } catch (e) { /* blocked */ }
    }

    // Copied and chat-posted text always carries both languages, whatever the reading aids are
    // set to - the person reading it in chat has their own preferences, not yours. Romaji goes
    // in too: in chat there is no toggle, and the person who cannot read the kanji is exactly
    // the person the message is for.
    //
    // One fact per line. The old "a - b - c - d" single line made a reader parse punctuation
    // to find the English while a call was still moving.
    function asLine(t) {
        const reading = [t.r, t.o].filter(Boolean).join(' / ');
        const out = [reading ? `${t.j}（${reading}）` : t.j, `= ${t.e}`];
        if (t.n) out.push(`※ ${t.n}`);
        if (t.xj) out.push(`例 ${t.xj}`);
        // U+3000 plus a space lines the translation up under the example above it.
        if (t.xe) out.push(`　 ${t.xe}`);
        return out.join('\n');
    }

    // -------------------------------------------------------------------- panel

    const CSS = `
#kaikei-fab{position:fixed;left:16px;top:50%;transform:translateY(-50%);z-index:2147483000;
 width:40px;height:40px;border-radius:50%;border:none;background:#1a73e8;color:#fff;
 font:600 16px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#kaikei-fab:hover{background:#1b66c9}
#kaikei-panel{position:fixed;left:68px;top:50%;transform:translateY(-50%);z-index:2147483000;
 width:580px;max-width:calc(100vw - 84px);
 background:#202124;color:#e8eaed;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.55);
 font:13px/1.5 system-ui,-apple-system,sans-serif;display:none;overflow:hidden}
#kaikei-panel.open{display:block}
#kaikei-bar{display:flex;align-items:center;background:#2b2c2e;padding-right:10px}
#kaikei-gemini{background:#3c4043;color:#cfe0f5;border:none;border-radius:5px;
  padding:5px 10px;font-size:12px;cursor:pointer;white-space:nowrap;margin-left:6px}
#kaikei-gemini:hover:not(:disabled){background:#4a5b74}
#kaikei-gemini:disabled{opacity:.6;cursor:default}
#kaikei-trace{position:fixed;right:16px;bottom:96px;z-index:2147483647;width:560px;
  max-width:calc(100vw - 32px);background:#202124;color:#e8eaed;border:1px solid #5f6368;
  border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.6);overflow:hidden}
#kaikei-trace .kaikei-trace-head{display:flex;align-items:center;gap:8px;background:#3c2b2b;
  padding:8px 10px;font:600 12px system-ui,sans-serif}
#kaikei-trace .kaikei-trace-head button{margin-left:auto;background:#3c4043;color:#e8eaed;
  border:none;border-radius:5px;padding:4px 9px;font-size:11px;cursor:pointer}
#kaikei-trace .kaikei-trace-head button+button{margin-left:0}
#kaikei-trace pre{margin:0;padding:10px;max-height:260px;overflow:auto;white-space:pre-wrap;
  font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9}
#kaikei-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;
  background:#202124;color:#e8eaed;border:1px solid #5f6368;border-radius:8px;
  padding:10px 16px;font-size:13px;max-width:520px;box-shadow:0 4px 16px rgba(0,0,0,.5);
  transition:opacity .6s}
#kaikei-toast.kaikei-fade{opacity:0}
#kaikei-input{flex:1;min-width:0;padding:12px 14px;border:none;outline:none;
 background:transparent;color:#e8eaed;font:14px/1.4 system-ui,sans-serif}
#kaikei-lang{display:flex;gap:2px;background:#202124;border-radius:6px;padding:2px}
#kaikei-lang button{background:transparent;color:#9aa0a6;border:none;border-radius:4px;
 padding:3px 9px;font:11px/1.4 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
#kaikei-lang button.on{background:#1a73e8;color:#fff}
#kaikei-results{max-height:min(60vh,480px);overflow-y:auto}
.kaikei-row{padding:9px 14px;border-top:1px solid #3c4043;cursor:pointer}
.kaikei-row:hover,.kaikei-row.sel{background:#303134}
.kaikei-jp{font-size:15px;font-weight:600}
.kaikei-rd{color:#9aa0a6;margin-left:7px;font-size:12px}
.kaikei-en{color:#8ab4f8;margin-top:1px}
.kaikei-note{color:#bdc1c6;margin-top:3px;font-size:12px}
/* Japanese and English sentences side by side, so the two read against each other.
   Wraps to stacked below ~380px of panel width. */
.kaikei-ex{display:flex;gap:10px;margin-top:5px;font-size:12px;flex-wrap:wrap}
.kaikei-ex > div{flex:1 1 46%;min-width:170px;border-left:2px solid #5f6368;padding-left:8px}
.kaikei-ex-ja{color:#c8cbcf}
.kaikei-ex-en{color:#9aa0a6}
.kaikei-sec{color:#80868b;margin-top:4px;font-size:11px}
.kaikei-acts{display:flex;gap:6px;margin-top:7px}
.kaikei-acts button{background:#3c4043;color:#e8eaed;border:none;border-radius:5px;
 padding:3px 9px;font-size:11px;cursor:pointer}
.kaikei-acts button:hover{background:#4a4d51}
.kaikei-acts button:disabled{opacity:.4;cursor:not-allowed}
.kaikei-acts button.kaikei-say{background:#2f4a6b;color:#cfe0f5}
.kaikei-acts button.kaikei-say:hover:not(:disabled){background:#3a5b82}
.kaikei-speakable{cursor:pointer}
.kaikei-speakable:hover{color:#8ab4f8}
ruby{ruby-position:over}
ruby rt{font-size:.55em;color:#9aa0a6;font-weight:400;user-select:none}
.kaikei-jp ruby rt{font-size:.5em}
/* Ruby needs headroom or the reading clips into the line above. */
.kaikei-jp,.kaikei-ex-ja{line-height:2.1}
#kaikei-voices{display:flex;gap:6px;align-items:center;padding:6px 14px;
 border-top:1px solid #3c4043;background:#26282a}
#kaikei-voices span{color:#80868b;font-size:11px}
`;

    let panel, input, results, fab, langBar, voiceBar;
    let current = [];
    let selected = 0;

    function render() {
        results.textContent = '';
        speakButtons.clear(); // rows are rebuilt on every keystroke; do not retain detached ones
        if (!current.length) {
            const empty = document.createElement('div');
            empty.className = 'kaikei-row';
            empty.style.color = '#9aa0a6';
            empty.textContent = input.value.trim() ? 'No match.' : `${TERMS.length} terms loaded.`;
            results.appendChild(empty);
            return;
        }

        current.forEach((t, i) => {
            const row = document.createElement('div');
            row.className = 'kaikei-row' + (i === selected ? ' sel' : '');
            row.addEventListener('mouseenter', () => {
                selected = i;
                [...results.children].forEach((c, j) => c.classList.toggle('sel', j === i));
            });

            const head = document.createElement('div');
            const jp = document.createElement('span');
            jp.className = 'kaikei-jp';
            // Furigana over the term itself. The reading covers the whole term, so one ruby
            // spans it - per-character splitting would need a morphological analyser and
            // would be guesswork.
            const hasKanji = /[一-鿿々]/.test(t.j);
            if (aid.furigana && t.r && hasKanji) {
                const ruby = document.createElement('ruby');
                ruby.append(t.j);
                const rt = document.createElement('rt');
                rt.textContent = t.r;
                ruby.appendChild(rt);
                jp.appendChild(ruby);
            } else {
                jp.textContent = t.j;
            }
            head.appendChild(jp);

            // With furigana off, the kana has to go somewhere or the reading is simply lost.
            const readings = [];
            if (t.r && (!aid.furigana || !hasKanji)) readings.push(t.r);
            if (aid.romaji && t.o) readings.push(t.o);
            if (readings.length) {
                const rd = document.createElement('span');
                rd.className = 'kaikei-rd';
                rd.textContent = readings.join('  ');
                head.appendChild(rd);
            }
            row.appendChild(head);

            const en = document.createElement('div');
            en.className = 'kaikei-en';
            en.textContent = t.e;
            row.appendChild(en);

            if (t.n) {
                const note = document.createElement('div');
                note.className = 'kaikei-note';
                note.textContent = t.n;
                row.appendChild(note);
            }

            // Japanese and English sentences sit side by side so the two can be read against
            // each other. Click either to hear it: the term inside a sentence carries the
            // pitch and rhythm that the isolated word does not.
            if (t.xj || t.xe) {
                const ex = document.createElement('div');
                ex.className = 'kaikei-ex';
                if (t.xj) {
                    const l = document.createElement('div');
                    l.className = 'kaikei-ex-ja kaikei-speakable';
                    l.title = 'Click to hear this sentence';
                    // Furigana from the deck's Pronunciation column, when the aid is on.
                    if (!aid.furigana || !t.xf || !appendFurigana(l, t.xf)) l.textContent = t.xj;
                    l.addEventListener('click', (ev) => { ev.stopPropagation(); speak(t.xj, 'ja', 'ja-JP'); });
                    ex.appendChild(l);
                }
                if (t.xe) {
                    const l = document.createElement('div');
                    l.className = 'kaikei-ex-en kaikei-speakable';
                    l.textContent = t.xe;
                    l.title = 'Click to hear this sentence';
                    l.addEventListener('click', (ev) => { ev.stopPropagation(); speak(t.xe, 'en', 'en-US'); });
                    ex.appendChild(l);
                }
                row.appendChild(ex);
            }

            const sectionLabel = t.se || t.s;
            if (sectionLabel) {
                const sec = document.createElement('div');
                sec.className = 'kaikei-sec';
                sec.textContent = sectionLabel;
                row.appendChild(sec);
            }

            const acts = document.createElement('div');
            acts.className = 'kaikei-acts';

            // Speak the kana reading when we have one: the engine's kanji reading is a guess,
            // and accounting kanji have irregular readings. 受注 is safe, 発注残 is not.
            const jaText = t.r || t.j;
            const bJa = document.createElement('button');
            bJa.className = 'kaikei-say';
            bJa.textContent = 'Say 日本語';
            bJa.addEventListener('click', (e) => {
                e.stopPropagation();
                speak(jaText, 'ja', 'ja-JP');
            });
            speakButtons.add({ btn: bJa, prefix: 'ja' });
            acts.appendChild(bJa);

            const bEn = document.createElement('button');
            bEn.className = 'kaikei-say';
            bEn.textContent = 'Say EN';
            bEn.addEventListener('click', (e) => {
                e.stopPropagation();
                speak(t.e, 'en', 'en-US');
            });
            speakButtons.add({ btn: bEn, prefix: 'en' });
            acts.appendChild(bEn);

            const bCopy = document.createElement('button');
            bCopy.textContent = 'Copy';
            bCopy.addEventListener('click', (e) => {
                e.stopPropagation();
                copy(asLine(t)).then((ok) => flash(bCopy, ok ? 'Copied' : 'Copy failed', 'Copy'));
            });
            acts.appendChild(bCopy);

            const bChat = document.createElement('button');
            bChat.textContent = 'Send to chat';
            bChat.addEventListener('click', (e) => {
                e.stopPropagation();
                const line = asLine(t);

                // Copy FIRST, synchronously, while the click's user activation is still
                // live. The chat handshake can take 9s, by which point a clipboard write
                // would be rejected. This way the text is always somewhere the user can
                // paste it, whatever the chat path does.
                const copied = copy(line);

                // Focus is sitting in the lookup box. Let it go, or the browser keeps it in
                // this document and the chat frame's insert writes into nothing.
                input.blur();
                bChat.blur();

                bChat.textContent = 'Sending...';
                const stage = (s) => { bChat.textContent = s; };
                postToChat(line, stage).then((res) => {
                    if (res === 'sent') return flash(bChat, 'Sent', 'Send to chat');
                    if (res === 'manual') return flash(bChat, 'Typed - press Enter', 'Send to chat', 5000);
                    showTrace(res);
                    return copied.then((ok) => {
                        if (!ok) return flash(bChat, 'Copy blocked', 'Send to chat', 4000);
                        // Each of these is a different fix, so none of them says "it failed".
                        if (res === 'no-agent') return flash(bChat, 'Copied - reinstall script', 'Send to chat', 6000);
                        if (res === 'no-toggle') return flash(bChat, 'Copied - open chat', 'Send to chat', 5000);
                        if (res === 'timeout') return flash(bChat, 'Copied - click again', 'Send to chat', 5000);
                        return flash(bChat, 'Copied instead', 'Send to chat', 4000);
                    });
                });
            });
            acts.appendChild(bChat);

            row.appendChild(acts);
            results.appendChild(row);
        });
    }

    // A failed send during a live call, explained on screen. Opening devtools mid-meeting to
    // read a console is not something anyone is going to do, so the trace comes to them with
    // a one-click copy. This only appears when a send did not land.
    function showTrace(res) {
        document.getElementById('kaikei-trace')?.remove();
        // A census of what is actually on the page, because every wrong theory so far came
        // from assuming a shape instead of looking. Editable fields and iframes are the two
        // things a send needs, so both get listed by whatever identifies them.
        const census = [];
        for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
            if (el.closest('#kaikei-panel')) continue;
            census.push('  ' + el.tagName.toLowerCase()
                + ' role=' + (el.getAttribute('role') || '-')
                + ' label=' + JSON.stringify((el.getAttribute('aria-label') || el.getAttribute('placeholder') || '-').slice(0, 60))
                + ' jsname=' + (el.getAttribute('jsname') || '-'));
        }
        const frames = [...document.querySelectorAll('iframe')]
            .map((f) => '  iframe src=' + (f.src || '(none)').slice(0, 80));

        // Buttons near each editable field, because "the text is in the box but nothing
        // sends" is a question about which button exists and what identifies it.
        const btnSet = new Set();
        for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
            if (el.closest('#kaikei-panel')) continue;
            let scope = el.parentElement;
            for (let up = 0; up < 5 && scope; up++, scope = scope.parentElement) {
                for (const b of scope.querySelectorAll('button')) btnSet.add(b);
            }
        }
        const buttons = [...btnSet].slice(0, 20).map((b) => '  button'
            + ' label=' + JSON.stringify((b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || '-').slice(0, 50))
            + ' jsname=' + (b.getAttribute('jsname') || '-')
            + ' icon=' + JSON.stringify([...b.querySelectorAll('i, span')].map((i) => i.textContent.trim()).filter(Boolean).join(',').slice(0, 30))
            + ' disabled=' + (b.disabled || b.getAttribute('aria-disabled') === 'true'));

        const body = 'Kaikei send result: ' + res + '\n'
            + 'chat=' + chatState() + ' agentSeen=' + agentSeen
            + ' frames=' + document.querySelectorAll(CHAT_IFRAME).length
            + ' hasFocus=' + document.hasFocus() + '\n'
            + 'editable fields on the page (' + census.length + '):\n'
            + (census.join('\n') || '  none') + '\n'
            + 'iframes (' + frames.length + '):\n'
            + (frames.join('\n') || '  none') + '\n'
            + 'buttons near editable fields (' + btnSet.size + '):\n'
            + (buttons.join('\n') || '  none') + '\n'
            + TRACE.join('\n');

        const box = document.createElement('div');
        box.id = 'kaikei-trace';

        const head = document.createElement('div');
        head.className = 'kaikei-trace-head';
        head.textContent = 'Send failed: ' + res;

        const bCopy = document.createElement('button');
        bCopy.textContent = 'Copy trace';
        bCopy.addEventListener('click', () => {
            copy(body).then((ok) => { bCopy.textContent = ok ? 'Copied' : 'Copy blocked'; });
        });

        const bClose = document.createElement('button');
        bClose.textContent = 'Close';
        bClose.addEventListener('click', () => box.remove());

        head.appendChild(bCopy);
        head.appendChild(bClose);

        const pre = document.createElement('pre');
        pre.textContent = body;

        box.appendChild(head);
        box.appendChild(pre);
        document.body.appendChild(box);
    }

    function syncLangBar() {
        for (const b of langBar.children) b.classList.toggle('on', Boolean(aid[b.dataset.aid]));
    }

    // There is no voice picker to build: Hattori was chosen by listening. This row carries
    // whichever standing warning applies and collapses to nothing when none does. It reports
    // the chat state because that decides whether Send is instant, slow, or impossible - and
    // it says so before the click rather than after twenty seconds of waiting.
    let noticeShown = null;
    let chatSeenOpenAt = 0;

    function noticeText() {
        if (!TTS) return 'This browser has no speech engine.';
        if (voices.length && !voicesFor('ja').length) return 'No Japanese voice installed - the Say 日本語 buttons are off.';
        const state = chatState();
        if (state === 'closed') return 'Meet chat is closed. Send will open it first.';
        if (state === 'opening') return 'Chat is opening...';
        if (state === 'unknown') return '';
        // Chat is open. Either our half is live in it, or it is not installed there.
        if (agentSeen) return '';
        if (chatSeenOpenAt && Date.now() - chatSeenOpenAt > SILENT_FRAME_MS) {
            // Naming the missing line matters: the usual cause is a dev loader carrying only
            // the meet.google.com match, and "reinstall" does not tell anyone that.
            return 'Chat is open but this script is not loaded inside it. Its installation is missing: @match https://chat.google.com/embed/*';
        }
        return 'Chat is opening...';
    }

    function buildVoiceNotice() {
        if (!voiceBar) return;
        if (chatState() === 'open' && !chatSeenOpenAt) chatSeenOpenAt = Date.now();
        if (chatState() !== 'open') chatSeenOpenAt = 0;
        const msg = noticeText();
        if (msg === noticeShown) return; // no churn on an unchanged state
        noticeShown = msg;
        voiceBar.textContent = '';
        voiceBar.style.display = msg ? '' : 'none';
        if (!msg) return;
        const s = document.createElement('span');
        s.textContent = msg;
        voiceBar.appendChild(s);
    }

    function flash(btn, msg, restore, ms) {
        btn.textContent = msg;
        setTimeout(() => { btn.textContent = restore; }, ms || 1400);
    }

    function update() {
        current = search(input.value);
        selected = 0;
        render();
    }

    // While the lookup panel is open, track the chat panel live: it can be opened by us, by
    // the user, or by Meet itself, and the notice has to follow. Two querySelectors twice a
    // second is nothing next to what Meet's own code does.
    let noticeTimer = null;
    function watchChatState(on) {
        if (on && !noticeTimer) noticeTimer = setInterval(buildVoiceNotice, 500);
        if (!on && noticeTimer) { clearInterval(noticeTimer); noticeTimer = null; }
    }

    function toggle(open) {
        const show = open ?? !panel.classList.contains('open');
        panel.classList.toggle('open', show);
        watchChatState(show);
        if (show) {
            buildVoiceNotice();
            input.focus();
            input.select();
        }
    }

    function build() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        fab = document.createElement('button');
        fab.id = 'kaikei-fab';
        fab.title = 'Accounting glossary - Alt+K to open or close';
        fab.textContent = '会';
        fab.addEventListener('click', () => toggle());

        panel = document.createElement('div');
        panel.id = 'kaikei-panel';

        input = document.createElement('input');
        input.id = 'kaikei-input';
        input.placeholder = 'Japanese, romaji, or English...';
        input.autocomplete = 'off';
        input.addEventListener('input', update);

        langBar = document.createElement('div');
        langBar.id = 'kaikei-lang';
        for (const a of AIDS) {
            const b = document.createElement('button');
            b.dataset.aid = a.key;
            b.textContent = a.label;
            b.title = a.title + ' - click to toggle';
            b.addEventListener('click', () => {
                setAid(a.key, !aid[a.key]);
                syncLangBar();
                render();
                input.focus();
            });
            langBar.appendChild(b);
        }

        // Loads the whole glossary plus the house rules into Meet's own Gemini, so the rest
        // of the call can be had in plain language with the model already primed. The FULL
        // payload - notes, example pairs, domain sections - is the default: a term Gemini
        // was never told about is a term it answers from Western training data. Shift-click
        // sends the compact terms-only variant for when the full one is too slow to land.
        const bGem = document.createElement('button');
        bGem.id = 'kaikei-gemini';
        bGem.type = 'button';
        bGem.textContent = 'Prime Gemini';
        bGem.title = 'Load the full glossary into Meet\'s Gemini. Shift-click for the compact terms-only version.';
        bGem.addEventListener('click', async (e) => {
            if (bGem.disabled) return;
            bGem.disabled = true;
            const restore = 'Prime Gemini';
            const res = await primeGemini(e.shiftKey, (s) => { bGem.textContent = s; });
            bGem.textContent = res === 'sent' ? 'Gemini primed'
                : res === 'no-gemini' ? 'Gemini not open' : 'Gemini refused';
            setTimeout(() => { bGem.textContent = restore; bGem.disabled = false; }, 4000);
            if (res !== 'sent') return;
            // The lookup panel has done its job and is now in the way of the conversation
            // it just enabled. Step aside and hand the caret to Gemini.
            toggle(false);
            toast('Gemini knows the accounting glossary. Ask it anything, in either language.');
            geminiBox()?.focus();
        });

        const bar = document.createElement('div');
        bar.id = 'kaikei-bar';
        bar.append(input, langBar, bGem);

        results = document.createElement('div');
        results.id = 'kaikei-results';

        // Voice picker. Which Japanese voice sounds acceptable is a judgement only the
        // listener can make, and the installed set differs per machine, so this is exposed
        // rather than hardcoded.
        voiceBar = document.createElement('div');
        voiceBar.id = 'kaikei-voices';

        panel.append(bar, results, voiceBar);
        syncLangBar();
        buildVoiceNotice();
        document.body.append(fab, panel);

        // Meet binds a lot of bare single-key shortcuts (d, e, ...), so typing in the search
        // box must not reach it. Modifier combos are let through: swallowing them killed our
        // own Alt+K, since the input has focus for as long as the panel is open.
        panel.addEventListener('keydown', (e) => {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            e.stopPropagation();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { toggle(false); return; }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!current.length) return;
                selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + current.length) % current.length;
                render();
                results.children[selected]?.scrollIntoView({ block: 'nearest' });
                return;
            }
            if (e.key === 'Enter' && current[selected]) {
                e.preventDefault();
                copy(asLine(current[selected]));
                input.value = '';
                update();
            }
        });

        // Capture phase, so it fires before Meet's own listeners and before the panel's
        // stopPropagation guard above.
        window.addEventListener('keydown', (e) => {
            if (e.altKey && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                e.stopPropagation();
                toggle();
            }
        }, true);

        update();

        if (DEBUG) {
            // One-shot environment report: everything the chat path depends on.
            const frames = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 60));
            dbg('loaded v2026.08.04.12, ' + TERMS.length + ' terms, furigana=' + aid.furigana + ' romaji=' + aid.romaji);
            dbg('chat iframe present: ' + Boolean(document.querySelector(CHAT_IFRAME)));
            dbg('iframes on page: ' + (frames.length ? frames.join(' | ') : 'none'));
            dbg('document.hasFocus: ' + document.hasFocus());
            dbg('chat toggle present: ' + Boolean(document.querySelector(CHAT_TOGGLE)));
        }
    }

    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, { once: true });
})();
