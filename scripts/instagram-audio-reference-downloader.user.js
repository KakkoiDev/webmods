// ==UserScript==
// @name         Instagram Audio Reference Downloader
// @namespace    http://tampermonkey.net/
// @version      2026.09.05
// @description  Finds audio/media URLs Instagram has already loaded in the browser and downloads them as local editing references
// @author       KakkoiDev
// @match        https://www.instagram.com/*
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @connect      instagram.com
// @connect      fbcdn.net
// @connect      cdninstagram.com
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const seen = new Map();
    const AUDIO_EXT_RE = /\.(?:m4a|mp3|aac|ogg|opus|wav)(?:$|[?#])/i;
    const MEDIA_EXT_RE = /\.(?:m4a|mp3|aac|ogg|opus|wav|mp4|webm)(?:$|[?#])/i;

    function safeUrl(value) {
        if (!value || typeof value !== 'string') return null;
        try {
            const url = new URL(value, location.href);
            if (url.protocol !== 'https:') return null;
            return url.href;
        } catch {
            return null;
        }
    }

    function scoreCandidate(url, kind, source) {
        let score = 0;
        if (kind === 'audio') score += 100;
        if (AUDIO_EXT_RE.test(url)) score += 80;
        if (/audio|music|m4a|aac|mp3|opus/i.test(url)) score += 30;
        if (/fbcdn\.net|cdninstagram\.com/i.test(url)) score += 15;
        if (source === 'media-element') score += 10;
        return score;
    }

    function addCandidate(value, kind = 'unknown', source = 'unknown') {
        const url = safeUrl(value);
        if (!url || !MEDIA_EXT_RE.test(url) && !/fbcdn\.net|cdninstagram\.com/i.test(url)) return;

        const existing = seen.get(url);
        const candidate = {
            url,
            kind,
            source,
            score: scoreCandidate(url, kind, source),
            seenAt: Date.now(),
        };

        if (!existing || candidate.score >= existing.score) seen.set(url, candidate);
        updateButton();
    }

    function scanMediaElements() {
        document.querySelectorAll('audio, video').forEach((el) => {
            const kind = el.tagName.toLowerCase();
            addCandidate(el.currentSrc, kind, 'media-element');
            addCandidate(el.src, kind, 'media-element');
            el.querySelectorAll('source[src]').forEach((source) => {
                addCandidate(source.src, kind, 'source-element');
            });
        });
    }

    function scanPerformanceEntries() {
        performance.getEntriesByType('resource').forEach((entry) => {
            const name = entry && entry.name;
            if (!name) return;
            if (MEDIA_EXT_RE.test(name) || /fbcdn\.net|cdninstagram\.com/i.test(name)) {
                addCandidate(name, AUDIO_EXT_RE.test(name) ? 'audio' : 'unknown', `performance:${entry.initiatorType || 'resource'}`);
            }
        });
    }

    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const name = entry && entry.name;
                if (!name) continue;
                if (MEDIA_EXT_RE.test(name) || /fbcdn\.net|cdninstagram\.com/i.test(name)) {
                    addCandidate(name, AUDIO_EXT_RE.test(name) ? 'audio' : 'unknown', `performance:${entry.initiatorType || 'resource'}`);
                }
            }
        });
        observer.observe({ type: 'resource', buffered: true });
    } catch {
        // PerformanceObserver is optional; DOM scanning still works.
    }

    const domObserver = new MutationObserver(() => {
        scanMediaElements();
        scanPerformanceEntries();
    });

    function candidates() {
        return [...seen.values()].sort((a, b) => b.score - a.score || b.seenAt - a.seenAt);
    }

    function extensionFor(candidate) {
        const path = new URL(candidate.url).pathname;
        const match = path.match(/\.([a-z0-9]{2,5})$/i);
        if (match) return match[1].toLowerCase();
        return candidate.kind === 'audio' ? 'm4a' : 'mp4';
    }

    function filenameFor(candidate) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `instagram-reference-${stamp}.${extensionFor(candidate)}`;
    }

    function downloadBest() {
        scanMediaElements();
        scanPerformanceEntries();

        const list = candidates();
        if (!list.length) {
            flash('No media found');
            return;
        }

        const candidate = list[0];
        flash(candidate.kind === 'audio' || AUDIO_EXT_RE.test(candidate.url) ? 'Downloading audio…' : 'Downloading media…');

        GM_download({
            url: candidate.url,
            name: filenameFor(candidate),
            saveAs: true,
            onload: () => flash('Downloaded'),
            onerror: () => flash('Download failed'),
            ontimeout: () => flash('Download timed out'),
        });
    }

    function downloadAllAudioCandidates() {
        scanMediaElements();
        scanPerformanceEntries();

        const list = candidates().filter((candidate) => candidate.kind === 'audio' || AUDIO_EXT_RE.test(candidate.url));
        if (!list.length) {
            flash('No separate audio found');
            return;
        }

        list.forEach((candidate, index) => {
            setTimeout(() => {
                GM_download({
                    url: candidate.url,
                    name: filenameFor(candidate),
                    saveAs: true,
                });
            }, index * 250);
        });
        flash(`${list.length} audio candidate${list.length === 1 ? '' : 's'}`);
    }

    let button;
    let flashTimer;

    function flash(text) {
        if (!button) return;
        const previous = button.dataset.label || '↓ Audio';
        button.textContent = text;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            button.textContent = previous;
        }, 1800);
    }

    function updateButton() {
        if (!button) return;
        const list = candidates();
        const audioCount = list.filter((candidate) => candidate.kind === 'audio' || AUDIO_EXT_RE.test(candidate.url)).length;
        const label = audioCount ? `↓ Audio (${audioCount})` : list.length ? `↓ Media (${list.length})` : '↓ Audio';
        button.dataset.label = label;
        if (!flashTimer) button.textContent = label;
    }

    function addButton() {
        if (document.getElementById('ig-audio-reference-download')) return;

        button = document.createElement('button');
        button.id = 'ig-audio-reference-download';
        button.type = 'button';
        button.textContent = '↓ Audio';
        button.dataset.label = '↓ Audio';
        Object.assign(button.style, {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            zIndex: '2147483647',
            padding: '9px 12px',
            border: '1px solid rgba(255,255,255,.25)',
            borderRadius: '999px',
            background: 'rgba(0,0,0,.78)',
            color: '#fff',
            font: '600 13px/1 system-ui, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0,0,0,.25)',
        });
        button.title = 'Download the best audio/media reference currently loaded by Instagram';
        button.addEventListener('click', downloadBest);
        document.body.appendChild(button);
        updateButton();
    }

    GM_registerMenuCommand('Download best Instagram audio/media reference', downloadBest);
    GM_registerMenuCommand('Download all separate audio candidates', downloadAllAudioCandidates);

    scanMediaElements();
    scanPerformanceEntries();
    addButton();

    domObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
})();
