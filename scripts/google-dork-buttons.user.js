// ==UserScript==
// @name         Google Dork Buttons
// @namespace    http://tampermonkey.net/
// @icon         https://www.google.com/favicon.ico
// @version      2026.09.18.2
// @description  Adds one-click Google dork operator buttons under the Google search bar
// @author       Cyril
// @match        https://www.google.com/*
// @include      https://www.google.tld/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // Google dork operators, one click to insert into the search box (cursor
    // placed right after, or between quotes/parens for the ones that need a
    // value). On the homepage they appear as a dropdown next to the "I'm
    // Feeling Lucky" button; on the results page as a dropdown at the end of the
    // toolbar under the search bar (after the "Tools" button). Anchors on stable
    // ids/names (#gbqfbb, #hdtb-tls, name="q") - never on hashed classes.
    const DORKS = [
        { label: 'site:',       insert: 'site:' },
        { label: 'intitle:',    insert: 'intitle:' },
        { label: 'inurl:',      insert: 'inurl:' },
        { label: 'intext:',     insert: 'intext:' },
        { label: 'allintitle:', insert: 'allintitle:' },
        { label: 'allinurl:',   insert: 'allinurl:' },
        { label: 'allintext:',  insert: 'allintext:' },
        { label: 'filetype:',   insert: 'filetype:' },
        { label: 'ext:',        insert: 'ext:' },
        { label: 'info:',       insert: 'info:' },
        { label: 'before:',     insert: 'before:' },
        { label: 'after:',      insert: 'after:' },
        { label: 'cache:',      insert: 'cache:' },
        { label: '"phrase"',    insert: '""',  caret: 1 },
        { label: '-exclude',    insert: '-' },
        { label: 'OR',          insert: ' OR ' },
        { label: '|',           insert: ' | ' },
        { label: '* wildcard',  insert: ' * ' },
        { label: '@social',     insert: '@' },
        { label: 'num..num',    insert: '..',  caret: 1 },
        { label: 'AROUND(x)',   insert: 'AROUND()', caret: 7 },
    ];

    function findBox() {
        return document.querySelector('textarea[name="q"], input[name="q"]');
    }

    // Set the value through the native prototype setter so Google's own input
    // controller (jsaction="input:...") sees the change, then fire an `input`.
    function setBoxValue(box, value) {
        const proto = box instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(box, value);
        else box.value = value;
    }

    function insertDork(box, dork) {
        const insert = dork.insert;
        const base = box.value || '';
        const sep = base ? ' ' : ''; // space-separate from an existing query
        const value = base + sep + insert;
        setBoxValue(box, value);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.focus();
        const caret = base.length + sep.length + (dork.caret != null ? dork.caret : insert.length);
        try { box.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ }
    }

    function makeDorkSelect(id, css) {
        const sel = document.createElement('select');
        sel.id = id;
        sel.title = 'Google dork operators';
        sel.style.cssText = css;

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Google Dorks';
        sel.appendChild(placeholder);

        for (const dork of DORKS) {
            const opt = document.createElement('option');
            opt.value = dork.insert;
            opt.textContent = dork.label;
            sel.appendChild(opt);
        }

        sel.addEventListener('change', () => {
            const dork = DORKS[sel.selectedIndex - 1]; // index 0 is the placeholder
            if (!dork) return;
            const box = findBox();
            if (box) insertDork(box, dork);
            sel.selectedIndex = 0; // reset so the same operator can be picked again
        });

        return sel;
    }

    function buildHomeSelect() {
        return makeDorkSelect('wmd-dork-select', [
            'background:#303134', 'color:#e8eaed',
            'border:1px solid #303134', 'border-radius:8px',
            'height:36px', 'margin:11px 4px', 'padding:0 16px',
            'font-family:Arial,sans-serif', 'font-size:14px',
            'cursor:pointer', 'vertical-align:middle',
        ].join(';'));
    }

    function buildToolbarSelect() {
        // Look like Google's "Tools" button: gray label + chevron-down, no fill,
        // subtle hover pill. Native select styled with appearance:none so the
        // closed control matches the toolbar while the OS still renders the menu.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z" fill="#9aa0a6"/></svg>';
        const chevron = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        const sel = makeDorkSelect('wmd-dork-select-toolbar', [
            'appearance:none', '-webkit-appearance:none', '-moz-appearance:none',
            'background-color:transparent',
            `background-image:url("${chevron}")`,
            'background-repeat:no-repeat',
            'background-position:right 4px center',
            'background-size:16px 16px',
            'color:#9aa0a6', 'border:none', 'border-radius:8px',
            'height:32px', 'margin:0 4px', 'padding:0 24px 0 8px',
            'font-family:Arial,sans-serif', 'font-size:14px',
            'cursor:pointer', 'align-self:center', 'white-space:nowrap',
            'outline:none',
        ].join(';'));
        sel.addEventListener('mouseenter', () => { sel.style.backgroundColor = '#3c4043'; });
        sel.addEventListener('mouseleave', () => { sel.style.backgroundColor = 'transparent'; });
        return sel;
    }

    function findLuckyButton() {
        return document.querySelector('#gbqfbb') || document.querySelector('input[name="btnI"]');
    }

    let el = null; // the injected select (homepage or results toolbar)

    function inject() {
        const box = findBox();
        if (!box) return;

        const lucky = findLuckyButton();
        if (lucky) {
            // Homepage: dropdown next to "I'm Feeling Lucky".
            if (!el || el.id !== 'wmd-dork-select') el = buildHomeSelect();
            if (el.isConnected && el.previousElementSibling === lucky) return;
            if (el.parentElement) el.remove();
            lucky.insertAdjacentElement('afterend', el);
            return;
        }

        // Results page: dropdown at the end of the toolbar, after the "Tools"
        // button (#hdtb-tls). Fall back to right under the search bar.
        const tools = document.getElementById('hdtb-tls');
        const target = (tools && tools.parentElement) || box.closest('form') || box.parentElement;
        if (!target) return;
        if (!el || el.id !== 'wmd-dork-select-toolbar') el = buildToolbarSelect();
        if (el.isConnected && el.previousElementSibling === target) return;
        if (el.parentElement) el.remove();
        target.insertAdjacentElement('afterend', el);
    }

    let pending = false;
    function scheduleInject() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; inject(); });
    }

    function start() {
        inject();
        // Google re-renders the toolbar/search box on some in-place navigations;
        // re-anchor the select whenever the DOM under it changes.
        const observer = new MutationObserver(scheduleInject);
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
        });
        window.addEventListener('resize', scheduleInject);
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
