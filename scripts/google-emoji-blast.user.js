// ==UserScript==
// @name         Google Emoji Blast
// @namespace    http://tampermonkey.net/
// @icon         https://www.google.com/favicon.ico
// @version      2026.09.28
// @description  Adds a button to the Google home page that blasts emoji across the screen
// @author       KakkoiDev
// @match        https://www.google.com/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/emoji-blast@0.11.0/dist/global.js
// @license      MIT
// ==/UserScript==

// The @require line loads emoji-blast's browser build, which sets window.emojiBlast.
// No GM_* APIs (@grant none) - the library only appends animated DOM nodes.
// Button shows on the home page ("/" and "/webhp"); removed on /search etc.
// Scoped to www.google.com only - other TLDs (google.co.jp, ...) are not covered.

(function() {
    'use strict';

    const WRAP_ID = 'emoji-blast-wrap';
    const EMOJIS = ['🎉', '✨', '🎊', '💥', '🥳'];

    function blast(e) {
        window.emojiBlast({
            emojis: EMOJIS,
            position: { x: e.clientX, y: e.clientY },
        });
    }

    // The Google logo is an inline <svg role="img" aria-label="Google"> (NOT an
    // <img>). aria-label is the stable anchor; the class (lnXdpd) is hashed.
    function logoEl() {
        const svgs = document.querySelectorAll('svg[aria-label="Google"], [role="img"][aria-label="Google"]');
        for (const el of svgs) {
            if (el.getClientRects().length) return el;
        }
        return svgs[0] || null;
    }

    // Absolute, anchored just above the logo's center - sits in the whitespace
    // above it WITHOUT shifting the logo (in-flow insertion pushed it down).
    function place(btn, logo) {
        const r = logo.getBoundingClientRect();
        btn.style.left = `${r.left + window.scrollX + r.width / 2}px`;
        btn.style.top = `${r.top + window.scrollY - btn.offsetHeight - 16}px`;
    }

    function ensureButton() {
        // The home page is served at both "/" and "/webhp" (e.g. ?hl=ja&sa=X...).
        if (location.pathname !== '/' && location.pathname !== '/webhp') {
            const ex = document.getElementById(WRAP_ID);
            if (ex) ex.remove();
            return;
        }
        const logo = logoEl();
        if (!logo) return;

        let btn = document.getElementById(WRAP_ID);
        if (!btn) {
            btn = document.createElement('button');
            btn.id = WRAP_ID;
            btn.type = 'button';
            btn.textContent = '🎉 Blast!';
            btn.title = 'Blast emoji!';
            btn.style.cssText = [
                'position:absolute', 'z-index:2147483647', 'transform:translateX(-50%)',
                'padding:10px 20px', 'font-size:15px', 'cursor:pointer',
                'border:none', 'border-radius:6px', 'background:#1a73e8',
                'color:#fff', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
            ].join(';');
            btn.addEventListener('click', blast);
            document.body.appendChild(btn);
        }
        place(btn, logo);
    }

    ensureButton();

    new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', ensureButton);
})();
