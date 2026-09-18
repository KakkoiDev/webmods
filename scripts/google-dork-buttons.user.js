// ==UserScript==
// @name         Google Dork Buttons
// @namespace    http://tampermonkey.net/
// @icon         https://www.google.com/favicon.ico
// @version      2026.09.18.1
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
    // Feeling Lucky" button; on the results page as a row of buttons under the
    // search bar. Anchors on the search box's name="q" (stable) and never on
    // hashed classes.
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

    // The rounded search pill is ~50px tall with a ~26px radius. Walk up from
    // the textarea to the first such ancestor so we never depend on the hashed
    // class name Google regenerates.
    function pillByGeometry(box) {
        let el = box.parentElement;
        while (el && el !== document.body && el !== document.documentElement) {
            const cs = getComputedStyle(el);
            const radius = parseFloat(cs.borderTopLeftRadius) || 0;
            if (el.offsetHeight >= 44 && radius >= 20) return el;
            el = el.parentElement;
        }
        return null;
    }

    function findAnchor(box) {
        return (
            box.closest('[jsname="RNNXgb"]') ||
            pillByGeometry(box) ||
            box.closest('form') ||
            box.parentElement
        );
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
        const value = (box.value || '') + insert;
        setBoxValue(box, value);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.focus();
        const caret = value.length - insert.length + (dork.caret != null ? dork.caret : insert.length);
        try { box.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ }
    }

    function buildBar() {
        const bar = document.createElement('div');
        bar.id = 'wmd-dork-bar';
        bar.style.cssText = [
            'display:flex', 'flex-wrap:wrap', 'gap:6px', 'align-items:center',
            'max-width:688px', 'margin:10px auto 0', 'padding:0 4px',
            'font-family:Arial,sans-serif',
        ].join(';');

        const label = document.createElement('span');
        label.textContent = 'Dorks:';
        label.style.cssText = 'color:#9aa0a6;font-size:13px;margin-right:2px;';
        bar.appendChild(label);

        for (const dork of DORKS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = dork.label;
            btn.title = dork.insert;
            btn.style.cssText = [
                'background:#303134', 'color:#e8eaed',
                'border:1px solid #5f6368', 'border-radius:9999px',
                'padding:4px 12px', 'font-size:13px', 'line-height:20px',
                'cursor:pointer', 'white-space:nowrap',
            ].join(';');
            btn.addEventListener('mouseenter', () => { btn.style.background = '#3c4043'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = '#303134'; });
            btn.addEventListener('click', () => {
                const box = findBox();
                if (box) insertDork(box, dork);
            });
            bar.appendChild(btn);
        }
        return bar;
    }

    function findLuckyButton() {
        return document.querySelector('#gbqfbb') || document.querySelector('input[name="btnI"]');
    }

    // Homepage: a single dropdown next to the "I'm Feeling Lucky" button.
    function buildSelect() {
        const sel = document.createElement('select');
        sel.id = 'wmd-dork-select';
        sel.style.cssText = [
            'background:#303134', 'color:#e8eaed',
            'border:1px solid #303134', 'border-radius:8px',
            'height:36px', 'margin:11px 4px', 'padding:0 16px',
            'font-family:Arial,sans-serif', 'font-size:14px',
            'cursor:pointer', 'vertical-align:middle',
        ].join(';');

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

    let el = null; // the injected element (select on the homepage, button bar on results)

    function inject() {
        const box = findBox();
        if (!box) return;

        const lucky = findLuckyButton();
        if (lucky) {
            // Homepage: dropdown next to "I'm Feeling Lucky".
            if (!el || el.id !== 'wmd-dork-select') el = buildSelect();
            if (el.isConnected && el.previousElementSibling === lucky) return;
            if (el.parentElement) el.remove();
            lucky.insertAdjacentElement('afterend', el);
            return;
        }

        // Results page: row of dork buttons under the search bar.
        const target = findAnchor(box);
        if (!target) return;
        if (!el || el.id !== 'wmd-dork-bar') el = buildBar();
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
        // Google re-renders the search box on some in-place navigations; re-anchor
        // the bar whenever the DOM under it changes.
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
