// ==UserScript==
// @name         Devbox Auto-Login
// @namespace    http://tampermonkey.net/
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIj48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjMTk3NmQyIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTEyIDdhMyAzIDAgMCAwLTMgM3YxSDhhMSAxIDAgMCAwLTEgMXY2YTEgMSAwIDAgMCAxIDFoOGExIDEgMCAwIDAgMS0xdi02YTEgMSAwIDAgMC0xLTFoLTF2LTFhMyAzIDAgMCAwLTMtM3ptMCAxLjVhMS41IDEuNSAwIDAgMSAxLjUgMS41djFoLTN2LTFBMS41IDEuNSAwIDAgMSAxMiA4LjV6Ii8+PC9zdmc+
// @version      2026.09.11.1
// @description  Auto-fills the shared devbox login form on PR preview environments
// @author       KakkoiDev
// @match        https://*.devbox.dev-pro-one-cloud.com/*
// @grant        none
// ==/UserScript==

// SHARED DEVBOX CREDENTIALS BELOW - do NOT add this script to greasyfork.json and do NOT
// publish it to Greasy Fork. It is for internal/local use only; ask before distributing it
// anywhere the credentials could leak (e.g. a public script host).

(function () {
    'use strict';

    // A wildcard is only valid as the leading character of a match-pattern host,
    // followed by "." or "/" (Chrome/Tampermonkey match pattern grammar) - a
    // mid-label wildcard like "app-pr-*.devbox..." is not valid syntax. @match
    // above matches the whole subdomain; this guard narrows to actual
    // "app-pr-<number>." hosts at runtime.
    if (!/^app-pr-\d+\./.test(location.hostname)) {
        return;
    }

    const EMAIL = 'devbox@meetsmore.com';
    const PASSWORD = 'devbox123!';

    // React (via MUI's controlled TextField) ignores a plain `el.value = x` assignment -
    // it re-renders from its own state on the next tick and wipes the DOM value. Using the
    // native input value setter bypasses React's tracking of the last value it set, so the
    // subsequent 'input' event looks like a real keystroke to React's change handler.
    function setReactInputValue(input, value) {
        const proto = window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function findShowPasswordCheckbox() {
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
            if (label.textContent && label.textContent.includes('パスワードを表示する')) {
                return label.querySelector('input[type="checkbox"]');
            }
        }
        return null;
    }

    function isCheckboxChecked(checkbox) {
        // `.checked` reflects MUI's actual state; data-testid is a fallback signal only
        // (the icon swaps CheckBoxIcon <-> CheckBoxOutlineBlankIcon on toggle).
        if (typeof checkbox.checked === 'boolean') return checkbox.checked;
        const svg = checkbox.parentElement && checkbox.parentElement.querySelector('svg[data-testid]');
        return !!svg && svg.getAttribute('data-testid') === 'CheckBoxIcon';
    }

    function findPasswordInput() {
        // Once "show password" starts checked, the field is rendered as type="text",
        // not type="password" - so type alone is not a reliable anchor. Prefer name/
        // autocomplete (stable regardless of visibility toggle), fall back to type.
        return document.querySelector(
            'input[name="password"], input[autocomplete="current-password"], ' +
            'input[autocomplete="new-password"], input[type="password"]'
        );
    }

    function fillForm() {
        const emailInput = document.querySelector('input[type="email"]');
        const passwordInput = findPasswordInput();
        if (!emailInput || !passwordInput) return false;

        if (emailInput.value !== EMAIL) {
            setReactInputValue(emailInput, EMAIL);
        }
        if (passwordInput.value !== PASSWORD) {
            setReactInputValue(passwordInput, PASSWORD);
        }

        if (emailInput.value !== EMAIL || passwordInput.value !== PASSWORD) {
            console.warn('[devbox-autologin] React state did not take, values read back mismatched');
        }

        const showPasswordCheckbox = findShowPasswordCheckbox();
        if (showPasswordCheckbox && !isCheckboxChecked(showPasswordCheckbox)) {
            showPasswordCheckbox.click();
        }

        return true;
    }

    if (fillForm()) return;

    const observer = new MutationObserver(() => {
        fillForm();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => observer.disconnect(), 15000);
})();
