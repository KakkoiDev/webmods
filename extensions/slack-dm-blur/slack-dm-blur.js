// GENERATED from scripts/slack-dm-blur.user.js by tools/build-extensions.mjs - do not edit.
// Edit the source userscript instead; this file is regenerated on commit.
// ==UserScript==
// @name         Slack DM Blur
// @namespace    http://tampermonkey.net/
// @icon         https://app.slack.com/favicon.ico
// @version      2026.07.28
// @description  Toggle in the Direct Messages header that blurs your DM feed and peek-card list so viewers can't read them while screensharing
// @author       KakkoiDev
// @match        https://app.slack.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

// Adds a "Blur" switch next to the Unreads toggle in the Direct Messages header
// (both the full feed and the hover peek card). While on, every DM row is CSS-blurred
// so viewers can't read names/previews during a screenshare. State persists across reloads
// and applies before first paint (no readable flash on reload).
//
// Keyboard backstop: Alt+Shift+B toggles blur even if the button fails to inject.
//
// Caveats: browser-only (the Slack desktop app runs none of this). Blur hides rendered
// pixels, not the DOM - it defeats shoulder-surfing, not devtools. Does NOT cover an open
// conversation thread, the Cmd/Ctrl+K quick switcher, notification toasts, or the tab title.

(function () {
    'use strict';

    // The Chrome extension build and the userscript both run in the page realm, so both can be
    // live at once. Without this, each would register the Alt+Shift+B backstop and one press
    // would toggle twice - a no-op. First instance to arm wins.
    if (window.__TMS_DM_BLUR_ARMED__) return;
    window.__TMS_DM_BLUR_ARMED__ = true;

    const DEBUG = false;
    const log = (...a) => { if (DEBUG) console.log('[slack-dm-blur]', ...a); };

    const ROW = '[data-qa="dms_channel"]';                  // DM row - shared by the feed and the peek card
    const ANCHOR = '[data-qa="dms-unreads-toggle-button"]'; // native Unreads toggle - our injection anchor
    const BTN_QA = 'tms-dm-blur-toggle-button';
    const ROOT_CLASS = 'tms-dm-blur-on';
    const READY_CLASS = 'tms-dm-blur-ready';  // present once we've read state; before it, blur is the default (fail-closed)
    const STORE_KEY = 'tms:slack-dm-blur';
    const BLUR_PX = 8;

    // State. @grant none => this is app.slack.com's own localStorage; key is namespaced to avoid collisions.
    function isOn() {
        try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
    }
    function persist(on) {
        try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* storage disabled */ }
    }

    // Slack drives the switch's on-visual off the .p-unreads_toggle--selected class, not aria-pressed,
    // so we toggle both to inherit the native green/slide.
    function syncButton(btn, on) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('p-unreads_toggle--selected', on);
    }
    function apply(on) {
        document.documentElement.classList.toggle(ROOT_CLASS, on);
        for (const btn of document.querySelectorAll(`[data-qa="${BTN_QA}"]`)) syncButton(btn, on);
    }
    function toggle() {
        const next = !isOn();
        persist(next);
        apply(next);
        log('toggled', next);
    }

    // One static stylesheet: just the blur rule (matches any present/future row, so virtualized
    // rows recycled on scroll are blurred before they paint). The toggle button borrows Slack's
    // native .p-unreads_toggle styling, so no switch CSS of our own.
    function injectStyle() {
        if (document.getElementById('tms-dm-blur-style')) return;
        const style = document.createElement('style');
        style.id = 'tms-dm-blur-style';
        style.textContent = `
            html.${ROOT_CLASS} ${ROW},
            html:not(.${READY_CLASS}) ${ROW} {
                filter: blur(${BLUR_PX}px) !important;
                user-select: none !important;
            }
            .p-peek_card__buttons [data-qa="${BTN_QA}"] {
                margin-right: 8px;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function buildButton() {
        const wrap = document.createElement('div');
        wrap.innerHTML = `<button class="c-button-unstyled p-unreads_toggle" data-qa="${BTN_QA}" aria-pressed="false" aria-label="Blur DMs for screen sharing" type="button" tabindex="0"><div class="p-unreads_toggle__label"><span class="c-truncate c-truncate--break_words" data-sk="tooltip_parent" style="--lines: 1; word-break: break-all;">Blur</span><span hidden="" data-sk="tooltip"></span></div><div class="p-unreads_toggle__switch"><div class="p-unreads_toggle__switch__handle"></div></div></button>`;
        const btn = wrap.firstElementChild;
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
        return btn;
    }

    // Inject next to every Unreads toggle (feed + peek card). Guard is per-parent, so a
    // remounted header gets a fresh button while duplicates in the same header are prevented.
    function ensureButtons() {
        const on = isOn();
        for (const anchor of document.querySelectorAll(ANCHOR)) {
            const parent = anchor.parentElement;
            if (!parent) continue;
            let btn = parent.querySelector(`[data-qa="${BTN_QA}"]`);
            if (!btn) {
                btn = buildButton();
                parent.insertBefore(btn, anchor);
                log('button injected');
            }
            syncButton(btn, on);
        }
    }

    // Boot: inject the stylesheet first, so the fail-closed default (blur every row until READY)
    // is in effect from the earliest frame; then read state and mark ready. All synchronous, before
    // Slack paints any row (documentElement always exists at document-start). If this ever fails to
    // run, rows stay blurred rather than leaking.
    injectStyle();
    apply(isOn());
    document.documentElement.classList.add(READY_CLASS);

    function start() {
        ensureButtons();
        let raf = 0;
        const obs = new MutationObserver(() => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; ensureButtons(); });
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);

    // Cross-tab sync: a 'storage' event fires in every OTHER tab when any tab writes the key,
    // so toggling blur in one Slack tab updates all the others.
    window.addEventListener('storage', (e) => {
        if (e.key === STORE_KEY) apply(isOn());
    });

    // Backstop: works even if the anchor was renamed and no button injected.
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.shiftKey && e.code === 'KeyB') {
            e.preventDefault();
            toggle();
        }
    });

    log('loaded');
})();
