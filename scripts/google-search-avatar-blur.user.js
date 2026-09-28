// ==UserScript==
// @name         Google Search Avatar Blur
// @namespace    http://tampermonkey.net/
// @icon         https://www.google.com/favicon.ico
// @version      2026.09.28
// @description  Blurs your profile avatar in the Google top bar
// @author       Cyril
// @match        https://www.google.com/*
// @include      https://www.google.tld/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // Blur the profile avatar in the Google top bar (the small round photo,
    // right of the app-launcher grid) so it can't be read while screensharing.
    // The avatar is the only <img> inside #gb served from googleusercontent.com;
    // the #gb id and the image host are stable, unlike Google's hashed classes.
    const style = document.createElement('style');
    // clip-path after the filter trims the blur that would otherwise spill
    // past the avatar's round edge.
    style.textContent = '#gb img[src*="googleusercontent.com"] { filter: blur(8px); clip-path: circle(50%); }';
    document.documentElement.appendChild(style);
})();
