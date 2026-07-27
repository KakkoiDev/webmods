// GENERATED from scripts/slack-ai-translate.user.js by tools/build-extensions.mjs - do not edit.
// Edit the source userscript instead; this file is regenerated on commit.

// GM shims for @grant GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_deleteValue - these replace Tampermonkey's APIs.
function GM_xmlhttpRequest(opts) {
    chrome.runtime.sendMessage(
        { __gm: 'xhr', method: opts.method || 'GET', url: opts.url,
          headers: opts.headers || {}, data: opts.data, timeout: opts.timeout },
        (res) => {
            if (chrome.runtime.lastError) return opts.onerror?.({ error: chrome.runtime.lastError.message });
            if (res.timeout) return opts.ontimeout?.();
            if (res.error) return opts.onerror?.(res);
            opts.onload?.({ status: res.status, responseText: res.responseText });
        }
    );
}
function GM_getValue(key, def) { return chrome.storage.local.get(key).then((o) => o[key] ?? def); }
function GM_setValue(key, value) { return chrome.storage.local.set({ [key]: value }); }
function GM_deleteValue(key) { return chrome.storage.local.remove(key); }
// ==UserScript==
// @name         Slack AI Translate
// @namespace    http://tampermonkey.net/
// @version      2026.07.27.1
// @description  Add English/Japanese translation button to Slack
// @author       KakkoiDev
// @match        https://app.slack.com/*
// @icon         https://app.slack.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      localhost
// @connect      127.0.0.1
// @license      MIT
// ==/UserScript==

// HOW TO USE
//
// A globe icon is added in two places: the message composer's toolbar (bottom
// row, next to the mic/video buttons) and every message's hover toolbar.
//
// 1. First run: RIGHT-CLICK the composer's globe icon to open the settings.
//    Pick a provider and fill in its pane:
//      - Gemini (default): free API key from https://aistudio.google.com/apikey
//      - Claude: API key from https://console.anthropic.com/settings/keys
//      - Ollama (local, free, private): install from https://ollama.com and
//        run `ollama pull gemma3:4b`. Use a 4b+ model; 1b models are too weak.
//    The translation prompt is editable there too ("Reset" restores the
//    default). Languages are EN <-> JA by default; edit the prompt to change.
// 2. Translate a message: hover it, click the globe in its toolbar. The text
//    is replaced by the translation; "See original" under the message toggles
//    back and forth. Re-rendered messages (scrolling) keep their translation.
// 3. Translate your draft: click the composer's globe. "Translating..." shows
//    under the text while the draft stays editable; the draft is then replaced
//    by the translation, with the same "See original" toggle. Typing dismisses
//    the toggle so it can never overwrite your edits.
//
// TODO:
// [x] The input translation doesn't work in the thread feed & in normal thread
// [x] The message translate button doesn't work at all
// [x] Use prettier loading icon than the rotating emoji (replaced by a status link under the message)
// [x] Improve dialog styling (Slack-styled modal, theme-aware via --sk_* vars)
// [x] Remove the translate button from images' toolbars (skip data-qa="file_actions" containers)
// [x] Add a | separator in the input toolbar to separate the translation icon from the other ones
// [x] Add an option to connect to a local Ollama model
// [x] Add right click open settings dialog
// [x] Add hover tooltip: "Translate\n[right click to open settings]"
// [x] Improve tooltip styling (custom Slack-look tooltip, 500ms delay)
// [x] fix styling of the translate icon: too large. Probably due to update in Slack's styling.

(async function() {
    'use strict';

    const CONSTANTS = {
        SELECTORS: {
            MESSAGE: '.c-virtual_list__item',
            INPUT: '.ql-editor',
            INPUT_TOOLBAR: '.c-texty_buttons',
            INPUT_WRAPPER: '.p-message_pane_input_inner_main',
            INPUT_CONTAINER: '[data-qa="message_input_container"]',
            WYSIWYG_CONTAINER: '.c-wysiwyg_container',
            QL_CONTAINER: '.ql-container',
            MESSAGE_TOOLBAR: '.c-message_actions__container',
            MESSAGE_DISPLAY: '.p-rich_text_block',
            MESSAGE_BLOCKS: '.c-message_kit__blocks',
            TIMESTAMP: '.c-timestamp',
            TS_WRAPPER: '[data-message-ts]'
        },
        CLASSES: {
            TRANSLATE_MESSAGE_BUTTON: 'translate-message-button',
            TRANSLATE_INPUT_BUTTON: 'translate-input-button',
            PROVIDER_SELECT: 'translate-provider-select',
            DIALOG_BODY: 'translate-dialog-body',
            STATUS_LINK: 'translate-status-link',
            INPUT_STATUS: 'translate-input-status',
            PROMPT_TEXTAREA: 'translate-prompt-textarea',
            PROMPT_RESET: 'translate-prompt-reset',
            PROVIDER_API_KEY: 'translate-provider-api-key',
            PROVIDER_MODEL: 'translate-provider-model',
            PROVIDER_HOST: 'translate-provider-host',
            TOOLTIP: 'translate-tooltip'
        },
        TYPES: {
            MESSAGE: 'message',
            INPUT: 'input'
        },
        STORAGE: {
            PROVIDER: 'slack-ai-translator-provider',
            GEMINI_API_KEY: 'slack-ai-translator-api-key',
            CLAUDE_API_KEY: 'slack-ai-translator-claude-api-key',
            GEMINI_MODEL: 'slack-ai-translator-gemini-model',
            CLAUDE_MODEL: 'slack-ai-translator-claude-model',
            OLLAMA_HOST: 'slack-ai-translator-local-model-host',
            OLLAMA_MODEL: 'slack-ai-translator-local-model-name',
            PROMPT: 'slack-ai-translator-prompt'
        },
        DEFAULTS: {
            GEMINI_MODEL: 'gemini-flash-latest',
            CLAUDE_MODEL: 'claude-haiku-4-5',
            OLLAMA_HOST: 'http://localhost:11434',
            OLLAMA_MODEL: 'gemma3:4b',
            PROMPT: `You are a translation engine. The input is an HTML fragment of a Slack message.
If the text is in English, translate it to Japanese. If it is in Japanese, translate it to English. If it mixes both, translate everything into the language used less in the input. If it is in neither language, return the input unchanged.
Respond with ONLY the translated HTML fragment: no extra words, no explanations, no greetings, no alternative translations, no code fences.
Keep every HTML tag exactly as in the input: same tags, same order, same attributes. Never add, remove, or change tags or attributes.
Translate only the visible text, including link labels.
Do NOT translate @mentions, #channel names, URLs, ticket IDs like ABC-123, or text inside <code> or <pre> tags.
Keep emojis exactly as they are (unicode emoji, :emoji_codes:, and emoji <img> tags). Do not add new emojis.`
        },
        MODEL_SUGGESTIONS: {
            gemini: ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'],
            claude: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
            ollama: ['gemma3:4b', 'gemma4:latest']
        }
    };

    class TranslationError extends Error {
        constructor(message, { authError = false } = {}) {
            super(message);
            this.authError = authError;
        }
    }

    // Settings live in GM storage, not in localStorage: localStorage is Slack's own
    // origin, so any script on the page could read the API keys. GM_getValue is
    // synchronous under Tampermonkey but returns a Promise under the Chrome-extension
    // shim, so every value is hydrated into CACHE once at startup and read from there.
    const CACHE = {};
    const cacheGet = (key) => CACHE[key] ?? null;
    const cacheSet = (key, value) => {
        CACHE[key] = value;
        GM_setValue(key, value);
    };
    const cacheDelete = (key) => {
        delete CACHE[key];
        GM_deleteValue(key);
    };

    // Helpers
    const HELPERS = {
        storage: {
            async hydrate() {
                for (const key of Object.values(CONSTANTS.STORAGE)) {
                    let value = await GM_getValue(key);
                    if (value == null) {
                        // one-time move of the values the previous version wrote to
                        // Slack's localStorage; the legacy copy is dropped so the keys
                        // stop being readable from the page
                        const legacy = localStorage.getItem(key);
                        if (legacy != null) {
                            value = legacy;
                            GM_setValue(key, legacy);
                            localStorage.removeItem(key);
                        }
                    }
                    if (value != null) CACHE[key] = value;
                }
            },

            get provider() {
                // legacy '-remote-or-local-model-select' is ignored on purpose: the old
                // script persisted it on select change but never implemented the local
                // path, so its value never reflected a working configuration
                return cacheGet(CONSTANTS.STORAGE.PROVIDER) || 'gemini';
            },
            set provider(value) {
                cacheSet(CONSTANTS.STORAGE.PROVIDER, value);
            },

            get geminiApiKey() {
                return cacheGet(CONSTANTS.STORAGE.GEMINI_API_KEY);
            },
            set geminiApiKey(value) {
                cacheSet(CONSTANTS.STORAGE.GEMINI_API_KEY, value);
            },

            get claudeApiKey() {
                return cacheGet(CONSTANTS.STORAGE.CLAUDE_API_KEY);
            },
            set claudeApiKey(value) {
                cacheSet(CONSTANTS.STORAGE.CLAUDE_API_KEY, value);
            },

            get geminiModel() {
                return cacheGet(CONSTANTS.STORAGE.GEMINI_MODEL) || CONSTANTS.DEFAULTS.GEMINI_MODEL;
            },
            set geminiModel(value) {
                cacheSet(CONSTANTS.STORAGE.GEMINI_MODEL, value);
            },

            get claudeModel() {
                return cacheGet(CONSTANTS.STORAGE.CLAUDE_MODEL) || CONSTANTS.DEFAULTS.CLAUDE_MODEL;
            },
            set claudeModel(value) {
                cacheSet(CONSTANTS.STORAGE.CLAUDE_MODEL, value);
            },

            get ollamaHost() {
                const raw = cacheGet(CONSTANTS.STORAGE.OLLAMA_HOST) || CONSTANTS.DEFAULTS.OLLAMA_HOST;
                // tolerate values pasted with the endpoint path or a trailing slash
                return raw.replace(/\/api\/(generate|chat)\/?$/, '').replace(/\/+$/, '');
            },
            set ollamaHost(value) {
                cacheSet(CONSTANTS.STORAGE.OLLAMA_HOST, value);
            },

            get ollamaModel() {
                return cacheGet(CONSTANTS.STORAGE.OLLAMA_MODEL) || CONSTANTS.DEFAULTS.OLLAMA_MODEL;
            },
            set ollamaModel(value) {
                cacheSet(CONSTANTS.STORAGE.OLLAMA_MODEL, value);
            },

            get prompt() {
                return cacheGet(CONSTANTS.STORAGE.PROMPT) || CONSTANTS.DEFAULTS.PROMPT;
            },
            set prompt(value) {
                const trimmed = (value ?? '').trim();
                // unset when empty or identical to the default so future default improvements reach the user
                if (!trimmed || trimmed === CONSTANTS.DEFAULTS.PROMPT) {
                    cacheDelete(CONSTANTS.STORAGE.PROMPT);
                } else {
                    cacheSet(CONSTANTS.STORAGE.PROMPT, trimmed);
                }
            }
        },

        httpPost({ url, headers, body }) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url,
                    headers: { 'Content-Type': 'application/json', ...headers },
                    data: JSON.stringify(body),
                    timeout: 60000,
                    onload: (response) => {
                        let json = null;
                        try { json = JSON.parse(response.responseText); } catch (e) { /* non-JSON body */ }
                        resolve({ status: response.status, json });
                    },
                    onerror: () => reject(new Error(`Network error reaching ${url}`)),
                    ontimeout: () => reject(new Error(`Request timed out reaching ${url}`))
                });
            });
        }
    };

    // Translation Service
    const PROVIDERS = {
        gemini: {
            label: 'Gemini',
            ready: () => !!HELPERS.storage.geminiApiKey,
            request: (text, prompt) => ({
                url: `https://generativelanguage.googleapis.com/v1beta/models/${HELPERS.storage.geminiModel}:generateContent?key=${HELPERS.storage.geminiApiKey}`,
                headers: {},
                body: { contents: [{ parts: [{ text: prompt }, { text }] }] }
            }),
            parse: (json) => json?.candidates?.[0]?.content?.parts?.[0]?.text,
            errorMessage: (status, json) => json?.error?.message,
            isAuthError: (status) => status === 400 || status === 403
        },
        claude: {
            label: 'Claude',
            ready: () => !!HELPERS.storage.claudeApiKey,
            request: (text, prompt) => ({
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'x-api-key': HELPERS.storage.claudeApiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: {
                    model: HELPERS.storage.claudeModel,
                    max_tokens: 8192,
                    system: prompt,
                    messages: [{ role: 'user', content: text }]
                }
            }),
            parse: (json) => (json?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join(''),
            errorMessage: (status, json) => json?.error?.message,
            isAuthError: (status) => status === 401 || status === 403
        },
        ollama: {
            label: 'Ollama (local)',
            ready: () => true,
            request: (text, prompt) => ({
                url: `${HELPERS.storage.ollamaHost}/api/chat`,
                headers: {},
                body: {
                    model: HELPERS.storage.ollamaModel,
                    stream: false,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: text }
                    ]
                }
            }),
            parse: (json) => json?.message?.content,
            errorMessage: (status, json) => json?.error || `HTTP ${status}`,
            isAuthError: () => false
        }
    };

    const TranslationService = {
        async translate(text) {
            const providerId = HELPERS.storage.provider;
            const provider = PROVIDERS[providerId];
            const prompt = HELPERS.storage.prompt;

            let result;
            try {
                result = await HELPERS.httpPost(provider.request(text, prompt));
            } catch (networkError) {
                if (providerId === 'ollama') {
                    throw new TranslationError(`Cannot reach Ollama at ${HELPERS.storage.ollamaHost}. Is it running?`);
                }
                throw new TranslationError(networkError.message);
            }

            const { status, json } = result;
            if (status < 200 || status >= 300) {
                throw new TranslationError(
                    provider.errorMessage(status, json) || `HTTP ${status}`,
                    { authError: provider.isAuthError(status, json) }
                );
            }

            const translated = provider.parse(json);
            if (!translated) {
                throw new TranslationError(`Empty response from ${providerId}`);
            }
            return translated;
        }
    };

    // Slack-styled hover tooltip for the translate buttons. Slack's own tooltip
    // system is wired through React props and never fires for injected buttons,
    // so this mimics it: dark rounded box, bold label, muted hint, hover delay.
    const Tooltip = {
        DELAY_MS: 500,
        el: null,
        timer: null,

        ensure() {
            if (this.el) return this.el;
            const el = document.createElement('div');
            el.className = CONSTANTS.CLASSES.TOOLTIP;
            el.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;display:none;'
                + 'background:#1a1d21;color:#fff;font-size:13px;font-weight:700;line-height:1.3;'
                + 'padding:8px 12px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);'
                + 'max-width:220px;text-align:center;';
            document.body.appendChild(el);
            this.el = el;
            return el;
        },

        schedule(target, label, hint) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.show(target, label, hint), this.DELAY_MS);
        },

        show(target, label, hint) {
            if (!target.isConnected) return;
            const el = this.ensure();
            el.innerHTML = hint
                ? `${label}<div style="font-weight:400;font-size:12px;opacity:.7;">${hint}</div>`
                : label;
            // render hidden first to measure, then center above the button
            el.style.display = 'block';
            el.style.visibility = 'hidden';
            const rect = target.getBoundingClientRect();
            const tip = el.getBoundingClientRect();
            let left = rect.left + rect.width / 2 - tip.width / 2;
            left = Math.max(4, Math.min(left, window.innerWidth - tip.width - 4));
            let top = rect.top - tip.height - 8;
            if (top < 4) top = rect.bottom + 8;
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.visibility = 'visible';
        },

        hide() {
            clearTimeout(this.timer);
            this.timer = null;
            if (this.el) this.el.style.display = 'none';
        }
    };

    // Composer translation state, keyed by the ql-editor element. Any user edit
    // dismisses the entry: the toggle must never overwrite typed content.
    const InputTranslationStore = new WeakMap();

    // Per-message translation state, keyed by message ts.
    // Entries survive Slack's virtual-list recycling; the MutationObserver re-applies them.
    const TranslationStore = {
        MAX_ENTRIES: 200,
        map: new Map(),
        get(key) {
            return key ? this.map.get(key) : undefined;
        },
        set(key, entry) {
            if (!this.map.has(key) && this.map.size >= this.MAX_ENTRIES) {
                this.map.delete(this.map.keys().next().value);
            }
            this.map.set(key, entry);
        },
        delete(key) {
            this.map.delete(key);
        }
    };

    // UI Components
    const UI = {
        translateSVG: '<svg data-xxz="true" data-qa="globe" aria-hidden="true" viewBox="0 0 20 20" class="" width="18" height="18"><path fill="currentColor" fill-rule="evenodd" d="M2.537 9.25a7.51 7.51 0 0 1 5.784-6.561c-.91 1.577-1.891 3.86-2.049 6.561zM10 2.815c-.905 1.41-2.044 3.691-2.225 6.435h4.45c-.181-2.744-1.32-5.025-2.225-6.435m2.225 7.935h-4.45c.181 2.744 1.32 5.025 2.225 6.435.905-1.41 2.044-3.691 2.225-6.435m-.546 6.561c.91-1.577 1.891-3.86 2.05-6.561h3.734a7.51 7.51 0 0 1-5.784 6.561m2.05-8.061c-.159-2.7-1.14-4.984-2.05-6.561a7.51 7.51 0 0 1 5.784 6.561zm-11.192 1.5h3.735c.158 2.7 1.138 4.984 2.05 6.561a7.505 7.505 0 0 1-5.785-6.561M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18" clip-rule="evenodd"></path></svg>',

        createTranslateButton(type) {
            const buttonClass = type === CONSTANTS.TYPES.MESSAGE
                ? CONSTANTS.CLASSES.TRANSLATE_MESSAGE_BUTTON
                : CONSTANTS.CLASSES.TRANSLATE_INPUT_BUTTON;
            const buttonHTML = `
                <button
                    class="${buttonClass} c-button-unstyled c-icon_button c-icon_button--size_small ${type === CONSTANTS.TYPES.MESSAGE ? 'c-message_actions__button' : 'p-video_composer_button c-wysiwyg_container__button c-wysiwyg_container__button--story_meeting'} c-icon_button--default"
                    data-qa="${type === CONSTANTS.TYPES.MESSAGE ? 'add_to_list' : 'video_composer_button'}"
                    ${type === CONSTANTS.TYPES.MESSAGE ? 'data-focus-key="message_actions"' : 'tabindex="-1"'}
                    aria-label="Translate"
                    ${type === CONSTANTS.TYPES.INPUT ? 'aria-expanded="false"' : ''}
                    type="button"
                >
                    ${this.translateSVG}
                </button>`;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buttonHTML;
            return wrapper.firstElementChild;
        },

        createStatusBar(className = CONSTANTS.CLASSES.STATUS_LINK) {
            const bar = document.createElement('div');
            bar.className = className;
            bar.style.cssText = 'font-size:12px;line-height:1.4;margin:4px 8px;user-select:none;';
            return bar;
        },

        // label is muted plain text ("Translated."), action renders as a Slack-styled link button
        setStatus(bar, label, action, title = '') {
            bar.innerHTML = `${label ? `<span style="opacity:.7;">${label}</span> ` : ''}${action ? `<button class="c-link--button" type="button">${action}</button>` : ''}`;
            bar.title = title;
        },

        // theme-aware via Slack's --sk_* CSS variables, with light-theme fallbacks
        dialogCSS: `
            dialog.translate-settings-dialog {
                background: rgb(var(--sk_primary_background, 255, 255, 255));
                color: rgb(var(--sk_primary_foreground, 29, 28, 29));
                border: none;
                border-radius: 12px;
                box-shadow: 0 0 0 1px rgba(0, 0, 0, .1), 0 18px 48px rgba(0, 0, 0, .35);
                padding: 0;
                width: 460px;
                max-width: 90vw;
            }
            dialog.translate-settings-dialog::backdrop { background: rgba(0, 0, 0, .45); }
            .translate-dialog-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 20px 28px 4px; font-size: 22px; font-weight: 900; line-height: 1.2;
            }
            .translate-dialog-close {
                background: none; border: none; color: inherit; opacity: .7;
                font-size: 18px; line-height: 1; cursor: pointer; padding: 6px 8px; border-radius: 4px;
            }
            .translate-dialog-close:hover {
                opacity: 1;
                background: rgba(var(--sk_primary_foreground, 29, 28, 29), .08);
            }
            .translate-dialog-content {
                padding: 0 28px 8px; max-height: 60vh; overflow-y: auto; font-size: 15px;
            }
            .translate-dialog-content label {
                display: block; font-weight: 700; font-size: 13px; margin: 14px 0 4px;
            }
            .translate-settings-dialog input,
            .translate-settings-dialog select,
            .translate-settings-dialog textarea {
                width: 100%; box-sizing: border-box; background: transparent; color: inherit;
                border: 1px solid rgba(var(--sk_primary_foreground, 29, 28, 29), .3);
                border-radius: 4px; padding: 8px 12px; font-size: 15px; font-family: inherit;
            }
            .translate-settings-dialog textarea { resize: vertical; }
            .translate-settings-dialog input:focus,
            .translate-settings-dialog select:focus,
            .translate-settings-dialog textarea:focus {
                outline: none;
                border-color: rgb(var(--sk_highlight, 18, 100, 163));
                box-shadow: 0 0 0 3px rgba(var(--sk_highlight, 18, 100, 163), .3);
            }
            .translate-dialog-content p { font-size: 13px; opacity: .75; margin: 8px 0 0; line-height: 1.4; }
            .translate-settings-dialog a { color: rgb(var(--sk_highlight, 18, 100, 163)); }
            .translate-settings-dialog code {
                font-family: Monaco, Menlo, Consolas, monospace; font-size: 12px;
                border: 1px solid rgba(var(--sk_primary_foreground, 29, 28, 29), .2);
                border-radius: 3px; padding: 1px 4px;
            }
            .translate-settings-dialog .translate-prompt-reset {
                margin-top: 8px; background: none; border: none; padding: 0;
                color: rgb(var(--sk_highlight, 18, 100, 163));
                font-size: 13px; font-weight: 700; cursor: pointer;
            }
            .translate-dialog-footer {
                display: flex; justify-content: flex-end; gap: 12px; padding: 16px 28px 24px; margin: 0;
            }
            .translate-dialog-footer button {
                font-weight: 700; font-size: 15px; border-radius: 4px;
                padding: 0 14px; height: 36px; cursor: pointer; font-family: inherit;
            }
            .translate-btn-outline {
                background: transparent; color: inherit;
                border: 1px solid rgba(var(--sk_primary_foreground, 29, 28, 29), .3);
            }
            .translate-btn-primary { background: #007a5a; color: #fff; border: none; }
            .translate-btn-primary:hover { background: #148567; }
        `,

        createSettingsDialog() {
            const dialog = document.createElement('dialog');
            dialog.className = 'translate-settings-dialog';
            dialog.setAttribute('closedby', 'any');
            dialog.innerHTML = `
                <div class="translate-dialog-header">
                    Translation settings
                    <button type="button" class="translate-dialog-close" aria-label="Close">✕</button>
                </div>
                <div class="translate-dialog-content">
                    <label>Provider</label>
                    <select class="${CONSTANTS.CLASSES.PROVIDER_SELECT}" name="provider">
                        <option value="gemini">Gemini</option>
                        <option value="claude">Claude (Anthropic)</option>
                        <option value="ollama">Ollama (local)</option>
                    </select>
                    <div class="${CONSTANTS.CLASSES.DIALOG_BODY}"></div>
                    <label>Translation prompt</label>
                    <textarea class="${CONSTANTS.CLASSES.PROMPT_TEXTAREA}" rows="8"></textarea>
                    <button type="button" class="${CONSTANTS.CLASSES.PROMPT_RESET}">Reset prompt to default</button>
                </div>
                <form method="dialog" class="translate-dialog-footer">
                    <button value="cancel" class="translate-btn-outline">Cancel</button>
                    <button value="ok" class="translate-btn-primary">Save</button>
                </form>`;
            return dialog;
        }
    };

    // UI Manager
    const UIManager = {
        addTranslateButtonToMessages(toolbars) {
            for (const toolbar of toolbars) {
                // file/image hover toolbars reuse .c-message_actions__container but are
                // not message toolbars; injecting there lands inside the download link
                if (toolbar.dataset.qa === 'file_actions') continue;
                const toolbarInner = toolbar.children[0];
                const lastElement = toolbarInner.children[toolbarInner.children.length - 1];
                const button = UI.createTranslateButton(CONSTANTS.TYPES.MESSAGE);
                toolbarInner.insertBefore(button, lastElement);
            }
        },

        addTranslateButtonToInput(inputToolbars) {
            for (const inputToolbar of inputToolbars) {
                if (inputToolbar.querySelector(`.${CONSTANTS.CLASSES.TRANSLATE_INPUT_BUTTON}`)) continue;
                // Slack's native divider class, so it matches the other | separators
                const divider = document.createElement('span');
                divider.className = 'c-wysiwyg_container__footer_divider';
                inputToolbar.appendChild(divider);
                const button = UI.createTranslateButton(CONSTANTS.TYPES.INPUT);
                inputToolbar.appendChild(button);
            }
        },

        extractTs(item, { create = false } = {}) {
            if (!item) return null;
            const dataTs = item.querySelector(CONSTANTS.SELECTORS.TIMESTAMP)?.getAttribute('data-ts')
                || item.querySelector(CONSTANTS.SELECTORS.TS_WRAPPER)?.getAttribute('data-message-ts');
            if (dataTs) return dataTs;
            if (item.id) return item.id;
            if (create) {
                // no stable ts found: mint a node-bound key (lost on recycle, same as pre-store behavior)
                if (!item.dataset.aiTranslateKey) {
                    item.dataset.aiTranslateKey = `k${Date.now()}${Math.floor(Math.random() * 1e6)}`;
                }
            }
            return item.dataset.aiTranslateKey || null;
        },

        // the bar sits at the bottom of the message (after the blocks container, before
        // reactions), mirroring where Slack's own translation bar renders
        getOrCreateStatusBar(item, messageDisplay) {
            const existing = item.querySelector(`.${CONSTANTS.CLASSES.STATUS_LINK}`);
            if (existing) return existing;
            const bar = UI.createStatusBar();
            const anchor = item.querySelector(CONSTANTS.SELECTORS.MESSAGE_BLOCKS) ?? messageDisplay;
            anchor.insertAdjacentElement('afterend', bar);
            return bar;
        },

        applyEntryToMessage(item, messageDisplay, entry) {
            const bar = this.getOrCreateStatusBar(item, messageDisplay);
            if (entry.showing === 'translated') {
                if (messageDisplay.innerHTML !== entry.translated) messageDisplay.innerHTML = entry.translated;
                UI.setStatus(bar, 'Translated.', 'See original');
            } else {
                if (messageDisplay.innerHTML !== entry.original) messageDisplay.innerHTML = entry.original;
                UI.setStatus(bar, '', 'See translation');
            }
        },

        toggleMessage(item, messageDisplay, entry) {
            entry.showing = entry.showing === 'translated' ? 'original' : 'translated';
            this.applyEntryToMessage(item, messageDisplay, entry);
        },

        async translateMessage(item) {
            if (!item) return;
            const messageDisplay = item.querySelector(CONSTANTS.SELECTORS.MESSAGE_DISPLAY);
            if (!messageDisplay) return;

            const key = this.extractTs(item, { create: true });
            const existing = TranslationStore.get(key);
            if (existing?.state === 'pending') return;
            if (existing?.state === 'done') {
                this.toggleMessage(item, messageDisplay, existing);
                return;
            }

            if (!PROVIDERS[HELPERS.storage.provider].ready()) {
                openSettings();
                return;
            }

            const entry = {
                original: messageDisplay.innerHTML,
                translated: null,
                showing: 'original',
                state: 'pending',
                errorMessage: null
            };
            TranslationStore.set(key, entry);

            const bar = this.getOrCreateStatusBar(item, messageDisplay);
            UI.setStatus(bar, 'Translating...', null);

            try {
                const translated = await TranslationService.translate(entry.original);
                entry.translated = translated;
                entry.showing = 'translated';
                entry.state = 'done';
                if (messageDisplay.isConnected) this.applyEntryToMessage(item, messageDisplay, entry);
            } catch (error) {
                console.error('Translation error:', error);
                entry.state = 'error';
                entry.errorMessage = error.message;
                if (messageDisplay.isConnected) {
                    UI.setStatus(bar, 'Translation failed.', 'Retry', error.message);
                }
                if (error.authError) openSettings();
            }
        },

        handleStatusBarClick(bar) {
            const item = bar.closest(CONSTANTS.SELECTORS.MESSAGE);
            const messageDisplay = item?.querySelector(CONSTANTS.SELECTORS.MESSAGE_DISPLAY);
            if (!messageDisplay) return;
            const key = this.extractTs(item);
            const entry = TranslationStore.get(key);
            if (!entry) {
                bar.remove();
                return;
            }
            if (entry.state === 'pending') return;
            if (entry.state === 'error') {
                TranslationStore.delete(key);
                this.translateMessage(item);
                return;
            }
            this.toggleMessage(item, messageDisplay, entry);
        },

        // Slack's virtual list recycles DOM nodes on scroll; re-apply stored translations
        // when a message re-renders. Best-effort: if the shell renders before the
        // rich-text child, the second trigger (added .p-rich_text_block) catches it.
        reapplyTranslations(messageDisplays) {
            for (const messageDisplay of messageDisplays) {
                const item = messageDisplay.closest(CONSTANTS.SELECTORS.MESSAGE);
                if (!item) continue;
                // only the message's canonical (first) rich-text block carries the translation;
                // nested blocks (quotes, attachments) must not be mistaken for an edited message
                if (item.querySelector(CONSTANTS.SELECTORS.MESSAGE_DISPLAY) !== messageDisplay) continue;
                const key = this.extractTs(item);
                const entry = TranslationStore.get(key);
                if (!entry || entry.state !== 'done') continue;
                if (messageDisplay.innerHTML === entry.translated) {
                    this.applyEntryToMessage(item, messageDisplay, entry);
                    continue;
                }
                if (messageDisplay.innerHTML !== entry.original) {
                    // message was edited since translation: never clobber the edit
                    TranslationStore.delete(key);
                    item.querySelector(`.${CONSTANTS.CLASSES.STATUS_LINK}`)?.remove();
                    continue;
                }
                this.applyEntryToMessage(item, messageDisplay, entry);
            }
        },

        resolveInput(targetElement) {
            return targetElement
                .closest(CONSTANTS.SELECTORS.INPUT_CONTAINER)
                ?.querySelector(CONSTANTS.SELECTORS.INPUT) ??
                targetElement
                .closest(CONSTANTS.SELECTORS.MESSAGE)
                ?.querySelector(CONSTANTS.SELECTORS.INPUT);
        },

        // scope containing both the input and its status bar, for lookups
        inputStatusScope(input) {
            return input.closest(CONSTANTS.SELECTORS.WYSIWYG_CONTAINER)
                ?? input.closest(CONSTANTS.SELECTORS.INPUT_CONTAINER)
                ?? input.parentElement;
        },

        getOrCreateInputStatusBar(input) {
            const scope = this.inputStatusScope(input);
            const existing = scope.querySelector(`.${CONSTANTS.CLASSES.INPUT_STATUS}`);
            if (existing) return existing;
            const bar = UI.createStatusBar(CONSTANTS.CLASSES.INPUT_STATUS);
            // inside .ql-container, after the editor. Slack styles these containers as
            // flex rows, which pushed the bar to the right of the text; forcing wrap +
            // a full-basis bar drops it onto its own line below the text, and both
            // properties are no-ops in plain block layout.
            bar.style.flexBasis = '100%';
            bar.style.width = '100%';
            const qlContainer = input.closest(CONSTANTS.SELECTORS.QL_CONTAINER);
            if (qlContainer) {
                qlContainer.style.flexWrap = 'wrap';
                qlContainer.appendChild(bar);
            } else {
                scope.appendChild(bar);
            }
            return bar;
        },

        dismissInputTranslation(input) {
            const entry = InputTranslationStore.get(input);
            if (entry?.onEdit) input.removeEventListener('input', entry.onEdit);
            InputTranslationStore.delete(input);
            this.inputStatusScope(input)?.querySelector(`.${CONSTANTS.CLASSES.INPUT_STATUS}`)?.remove();
        },

        async translateInput(input) {
            if (!input) return;
            if (!PROVIDERS[HELPERS.storage.provider].ready()) {
                openSettings();
                return;
            }

            const bar = this.getOrCreateInputStatusBar(input);
            if (bar.dataset.state === 'pending') return;
            bar.dataset.state = 'pending';
            UI.setStatus(bar, 'Translating...', null);

            const original = input.innerHTML;

            try {
                const translatedText = await TranslationService.translate(original);
                const sanitizedText = translatedText
                    .replace(/(?:<p>(?:<br\s*\/?>|[\s\\n\r]*)<\/p>[\s\r\n]*)+$/gmi, '')
                    .replace(/[\r\n]+$/g, '');
                if (input.innerHTML !== original) {
                    // the user kept typing while the request was in flight: their edits win
                    this.dismissInputTranslation(input);
                    return;
                }
                const entry = { original, translated: sanitizedText, showing: 'translated' };
                entry.onEdit = () => this.dismissInputTranslation(input);
                InputTranslationStore.set(input, entry);
                input.innerHTML = sanitizedText;
                // typing dismisses the toggle: from then on the draft is the user's own
                input.addEventListener('input', entry.onEdit, { once: true });
                bar.dataset.state = 'done';
                UI.setStatus(bar, 'Translated.', 'See original');
            } catch (error) {
                console.error('Translation error:', error);
                bar.dataset.state = 'error';
                UI.setStatus(bar, 'Translation failed.', 'Retry', error.message);
                if (error.authError) openSettings();
            }
        },

        handleInputStatusBarClick(bar) {
            const input = bar.closest(CONSTANTS.SELECTORS.INPUT_CONTAINER)
                ?.querySelector(CONSTANTS.SELECTORS.INPUT) ??
                bar.closest(CONSTANTS.SELECTORS.WYSIWYG_CONTAINER)
                ?.querySelector(CONSTANTS.SELECTORS.INPUT) ??
                bar.parentElement?.querySelector(CONSTANTS.SELECTORS.INPUT);

            if (bar.dataset.state === 'error') {
                bar.remove();
                if (input) this.translateInput(input);
                return;
            }
            if (bar.dataset.state !== 'done' || !input) return;

            const entry = InputTranslationStore.get(input);
            if (!entry) {
                bar.remove();
                return;
            }
            const expected = entry.showing === 'translated' ? entry.translated : entry.original;
            if (input.innerHTML !== expected) {
                // draft changed under us (edit we didn't catch, Slack draft restore):
                // never overwrite it
                this.dismissInputTranslation(input);
                return;
            }
            if (entry.showing === 'translated') {
                input.innerHTML = entry.original;
                entry.showing = 'original';
                UI.setStatus(bar, '', 'See translation');
            } else {
                input.innerHTML = entry.translated;
                entry.showing = 'translated';
                UI.setStatus(bar, 'Translated.', 'See original');
            }
        },

        swapDialogBody(dialog, provider) {
            const dialogBody = dialog.querySelector(`.${CONSTANTS.CLASSES.DIALOG_BODY}`);
            const storage = HELPERS.storage;
            const modelDatalist = `
                <datalist id="translate-model-suggestions">
                    ${CONSTANTS.MODEL_SUGGESTIONS[provider].map((id) => `<option value="${id}"></option>`).join('')}
                </datalist>`;

            switch (provider) {
                case 'gemini':
                    dialogBody.innerHTML = `
                        <label>API key</label>
                        <input class="${CONSTANTS.CLASSES.PROVIDER_API_KEY}">
                        <label>Model</label>
                        <input class="${CONSTANTS.CLASSES.PROVIDER_MODEL}" list="translate-model-suggestions">
                        ${modelDatalist}
                        <p>Get a free Gemini API key <a href="https://ai.google.dev/gemini-api/docs/api-key" target="_blank">here</a>.</p>
                        <p>Warning: the API key is stored unencrypted in your browser's local storage.</p>
                        <p>Warning: Google will own whatever data you pass to it. More information <a href="https://support.google.com/gemini/answer/13594961?hl=en#your_data" target="_blank">here</a>.</p>`;
                    dialogBody.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_API_KEY}`).value = storage.geminiApiKey ?? '';
                    dialogBody.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_MODEL}`).value = storage.geminiModel;
                    break;
                case 'claude':
                    dialogBody.innerHTML = `
                        <label>API key</label>
                        <input class="${CONSTANTS.CLASSES.PROVIDER_API_KEY}">
                        <label>Model</label>
                        <input class="${CONSTANTS.CLASSES.PROVIDER_MODEL}" list="translate-model-suggestions">
                        ${modelDatalist}
                        <p>Create an API key in the <a href="https://console.anthropic.com/settings/keys" target="_blank">Anthropic Console</a> (requires an Anthropic account with credits).</p>
                        <p>Warning: the API key is stored unencrypted in your browser's local storage and sent directly from your browser to api.anthropic.com.</p>`;
                    dialogBody.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_API_KEY}`).value = storage.claudeApiKey ?? '';
                    dialogBody.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_MODEL}`).value = storage.claudeModel;
                    break;
                case 'ollama':
                    dialogBody.innerHTML = `
                        <label>Host</label>
                        <input class="${CONSTANTS.CLASSES.PROVIDER_HOST}">
                        <label>Model</label>
                        <input class="${CONSTANTS.CLASSES.PROVIDER_MODEL}" list="translate-model-suggestions">
                        ${modelDatalist}
                        <p>Setup: install Ollama from <a href="https://ollama.com" target="_blank">ollama.com</a>, then run <code>ollama pull ${CONSTANTS.DEFAULTS.OLLAMA_MODEL}</code>. No API key needed; nothing leaves your machine.</p>
                        <p>Use a 4b-parameter model or larger: 1b-class models (e.g. gemma3:1b) receive the translation prompt but are too weak to follow it and tend to echo the message back untranslated. Larger models (e.g. gemma4) also preserve message formatting like links and mentions more reliably.</p>`;
                    dialogBody.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_HOST}`).value = storage.ollamaHost;
                    dialogBody.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_MODEL}`).value = storage.ollamaModel;
                    break;
            }
        }
    };

    // Initialize
    await HELPERS.storage.hydrate();

    const dialogStyle = document.createElement('style');
    dialogStyle.textContent = UI.dialogCSS;
    document.head.appendChild(dialogStyle);

    const dialog = UI.createSettingsDialog();
    document.body.appendChild(dialog);

    dialog.querySelector('.translate-dialog-close').addEventListener('click', () => dialog.close());

    function openSettings() {
        if (dialog.open) return;
        // closedby="any" fires 'close' without setting returnValue; a stale 'ok' from a
        // previous submit would otherwise persist fields on an outside-click dismissal
        dialog.returnValue = '';
        const provider = HELPERS.storage.provider;
        dialog.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_SELECT}`).value = provider;
        UIManager.swapDialogBody(dialog, provider);
        dialog.querySelector(`.${CONSTANTS.CLASSES.PROMPT_TEXTAREA}`).value = HELPERS.storage.prompt;
        dialog.showModal();
    }

    // pane swap only; nothing persists until OK
    dialog.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_SELECT}`).addEventListener('change', (event) => {
        UIManager.swapDialogBody(dialog, event.target.value);
    });

    dialog.querySelector(`.${CONSTANTS.CLASSES.PROMPT_RESET}`).addEventListener('click', () => {
        dialog.querySelector(`.${CONSTANTS.CLASSES.PROMPT_TEXTAREA}`).value = CONSTANTS.DEFAULTS.PROMPT;
    });

    dialog.addEventListener('close', () => {
        if (dialog.returnValue !== 'ok') return;
        const storage = HELPERS.storage;
        const provider = dialog.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_SELECT}`).value;
        storage.provider = provider;

        const apiKey = dialog.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_API_KEY}`)?.value.trim();
        const model = dialog.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_MODEL}`)?.value.trim();
        const host = dialog.querySelector(`.${CONSTANTS.CLASSES.PROVIDER_HOST}`)?.value.trim();

        if (provider === 'gemini') {
            if (apiKey != null) storage.geminiApiKey = apiKey;
            storage.geminiModel = model || CONSTANTS.DEFAULTS.GEMINI_MODEL;
        } else if (provider === 'claude') {
            if (apiKey != null) storage.claudeApiKey = apiKey;
            storage.claudeModel = model || CONSTANTS.DEFAULTS.CLAUDE_MODEL;
        } else if (provider === 'ollama') {
            storage.ollamaHost = host || CONSTANTS.DEFAULTS.OLLAMA_HOST;
            storage.ollamaModel = model || CONSTANTS.DEFAULTS.OLLAMA_MODEL;
        }

        storage.prompt = dialog.querySelector(`.${CONSTANTS.CLASSES.PROMPT_TEXTAREA}`).value;
    });

    // Event Listeners
    let hoveredTranslateButton = null;
    document.body.addEventListener('mouseover', (event) => {
        const button = event.target.closest(
            `.${CONSTANTS.CLASSES.TRANSLATE_MESSAGE_BUTTON}, .${CONSTANTS.CLASSES.TRANSLATE_INPUT_BUTTON}`
        );
        if (button === hoveredTranslateButton) return;
        hoveredTranslateButton = button;
        Tooltip.hide();
        if (!button) return;
        const isInput = button.classList.contains(CONSTANTS.CLASSES.TRANSLATE_INPUT_BUTTON);
        Tooltip.schedule(button, 'Translate', isInput ? 'Right click to open options' : null);
    });

    document.documentElement.addEventListener('mouseleave', () => {
        hoveredTranslateButton = null;
        Tooltip.hide();
    });

    document.body.addEventListener('click', async (event) => {
        Tooltip.hide();
        const inputStatusBar = event.target.closest(`.${CONSTANTS.CLASSES.INPUT_STATUS}`);
        if (inputStatusBar) {
            UIManager.handleInputStatusBarClick(inputStatusBar);
            return;
        }

        const statusBar = event.target.closest(`.${CONSTANTS.CLASSES.STATUS_LINK}`);
        if (statusBar) {
            UIManager.handleStatusBarClick(statusBar);
            return;
        }

        const targetMessageButton = event.target.closest(`.${CONSTANTS.CLASSES.TRANSLATE_MESSAGE_BUTTON}`);
        if (targetMessageButton) {
            await UIManager.translateMessage(targetMessageButton.closest(CONSTANTS.SELECTORS.MESSAGE));
            return;
        }

        const targetInputButton = event.target.closest(`.${CONSTANTS.CLASSES.TRANSLATE_INPUT_BUTTON}`);
        if (targetInputButton) {
            await UIManager.translateInput(UIManager.resolveInput(targetInputButton));
        }
    });

    document.body.addEventListener('contextmenu', (event) => {
        const targetInputButton = event.target.closest(`.${CONSTANTS.CLASSES.TRANSLATE_INPUT_BUTTON}`);

        if (targetInputButton) {
            event.preventDefault();
            Tooltip.hide();
            // Wait for next mouseup
            // Needed because the dialog's closeby=any gets triggered on mouseup
            const handler = () => {
                openSettings();
                document.removeEventListener('mouseup', handler);
            };
            document.addEventListener('mouseup', handler, {once: true});
        }
    });

    // Mutation Observer
    const observer = new MutationObserver((mutations) => {
        const allMutatedElementNodes = mutations
            .filter(mutation => mutation.type === 'childList')
            .flatMap(mutation => [...mutation.addedNodes])
            .filter(node => node.nodeType === Node.ELEMENT_NODE);

        const addedMessages = allMutatedElementNodes.filter(
            node => node.matches && node.matches(CONSTANTS.SELECTORS.MESSAGE_TOOLBAR)
        );
        UIManager.addTranslateButtonToMessages(addedMessages);

        const addedInputToolbarWrappers = allMutatedElementNodes
            .filter(node => node.querySelector(CONSTANTS.SELECTORS.INPUT_TOOLBAR));
        const addedInputToolbars = addedInputToolbarWrappers
            .flatMap(wrapper => [...wrapper.querySelectorAll(CONSTANTS.SELECTORS.INPUT_TOOLBAR)]);
        UIManager.addTranslateButtonToInput(addedInputToolbars);

        // re-apply stored translations to recycled virtual-list nodes
        const touchedDisplays = new Set(allMutatedElementNodes.flatMap(node => {
            const displays = node.matches?.(CONSTANTS.SELECTORS.MESSAGE_DISPLAY)
                ? [node]
                : [...(node.querySelectorAll?.(CONSTANTS.SELECTORS.MESSAGE_DISPLAY) ?? [])];
            return displays;
        }));
        if (touchedDisplays.size) UIManager.reapplyTranslations(touchedDisplays);
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();
