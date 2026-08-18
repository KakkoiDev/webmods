/* @webmods/annotate v0.1.0 | MIT | https://github.com/KakkoiDev/webmods */
"use strict";
var WebmodsAnnotate = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    ARCHIVED_KEY: () => ARCHIVED_KEY,
    DocumentStorage: () => DocumentStorage,
    INLINE_FRAGMENT_PARAM: () => INLINE_FRAGMENT_PARAM,
    NOTE_FRAGMENT_PARAM: () => NOTE_FRAGMENT_PARAM,
    SCHEMA_VERSION: () => SCHEMA_VERSION,
    archivedAt: () => archivedAt,
    blockTextWithMap: () => blockTextWithMap,
    buildExcludeFn: () => buildExcludeFn,
    buildRange: () => buildRange,
    buildSelector: () => buildSelector,
    buildSystemPrompt: () => buildSystemPrompt,
    buildXPath: () => buildXPath,
    collectPages: () => collectPages,
    copyText: () => copyText,
    create: () => createAnnotator,
    createAnchor: () => createAnchor,
    createAnnotator: () => createAnnotator,
    createChatPlugin: () => createChatPlugin,
    createClaudeProvider: () => createClaudeProvider,
    createCommandRegistry: () => createCommandRegistry,
    createDefaultBlockResolver: () => createDefaultBlockResolver,
    createDefaultPageIdentityResolver: () => createDefaultPageIdentityResolver,
    createEchoProvider: () => createEchoProvider,
    createExcalidrawPlugin: () => createExcalidrawPlugin,
    createGlobalBrowserPlugin: () => createGlobalBrowserPlugin,
    createIndexedDBStorage: () => createIndexedDBStorage,
    createLocalStorageStorage: () => createLocalStorageStorage,
    createMemoryStorage: () => createMemoryStorage,
    createOpenAIProvider: () => createOpenAIProvider,
    createPortableDataPlugin: () => createPortableDataPlugin,
    createRangeAnchor: () => createRangeAnchor,
    createTampermonkeyStorage: () => createTampermonkeyStorage,
    download: () => download,
    emptyDB: () => emptyDB,
    exportFilename: () => exportFilename,
    filterPagesByScope: () => filterPagesByScope,
    generateId: () => generateId,
    hashString: () => hashString,
    indexedDBStorage: () => createIndexedDBStorage,
    isArchived: () => isArchived,
    isExcalidrawAttachment: () => isExcalidrawAttachment,
    localStorageStorage: () => createLocalStorageStorage,
    memoryStorage: () => createMemoryStorage,
    migrateDB: () => migrateDB,
    normalizeText: () => normalizeText,
    normalizeUrl: () => normalizeUrl,
    noteLink: () => noteLink,
    parseSSE: () => parseSSE,
    rangeOffsets: () => rangeOffsets,
    renderMarkdown: () => renderMarkdown,
    resolveAnchor: () => resolveAnchor,
    resolveRangeInBlock: () => resolveRangeInBlock,
    scoreBlock: () => scoreBlock,
    searchAnnotations: () => searchAnnotations,
    stripOwnFragment: () => stripOwnFragment,
    tampermonkeyStorage: () => createTampermonkeyStorage,
    textSimilarity: () => textSimilarity,
    validateAnnotation: () => validateAnnotation,
    validateExportDocument: () => validateExportDocument
  });

  // src/blocks.ts
  var SEMANTIC_TAGS = /* @__PURE__ */ new Set([
    "ARTICLE",
    "SECTION",
    "P",
    "LI",
    "BLOCKQUOTE",
    "PRE",
    "FIGURE",
    "TABLE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "DD",
    "DT",
    "ASIDE",
    "MAIN",
    "SUMMARY",
    "CAPTION",
    "TD",
    "TH"
  ]);
  var CONTROL_TAGS = /* @__PURE__ */ new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION", "LABEL", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "SVG"]);
  var SKIP_CONTAINERS = /* @__PURE__ */ new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  var UI_ATTR = "data-wm-annotate-ui";
  function isAnnotatorUI(el) {
    return !!el.closest(`[${UI_ATTR}]`) || !!(el.getRootNode() instanceof ShadowRoot && el.getRootNode().host?.hasAttribute(UI_ATTR));
  }
  function buildExcludeFn(exclude) {
    if (!exclude) return () => false;
    if (typeof exclude === "function") return exclude;
    const selectors = exclude.join(",");
    return (el) => selectors ? !!el.closest(selectors) : false;
  }
  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (el.hidden) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  }
  function ownTextLength(el) {
    return (el.textContent || "").trim().length;
  }
  var EDITABLE_SELECTOR = '[contenteditable=""],[contenteditable="true"]';
  var DOCUMENT_EDITOR_MIN_TEXT = 400;
  function outermostEditableRoot(el) {
    let root = null;
    let current = el.closest(EDITABLE_SELECTOR);
    while (current) {
      root = current;
      current = current.parentElement?.closest(EDITABLE_SELECTOR) ?? null;
    }
    return root;
  }
  function inDocumentEditor(el) {
    const root = outermostEditableRoot(el);
    return !!root && (root.textContent || "").trim().length >= DOCUMENT_EDITOR_MIN_TEXT;
  }
  function isInteractive(el) {
    if (CONTROL_TAGS.has(el.tagName)) return true;
    if (el instanceof HTMLElement && el.draggable) return true;
    const editableDocument = inDocumentEditor(el);
    if (el instanceof HTMLElement && el.isContentEditable && !editableDocument) return true;
    const role = el.getAttribute("role");
    if (role && ["button", "textbox", "slider", "checkbox", "switch", "combobox", "menuitem"].includes(role)) {
      return !(editableDocument && role === "textbox");
    }
    return false;
  }
  function isNavOrOverlay(el) {
    const tag = el.tagName;
    if (tag === "NAV") return true;
    const role = el.getAttribute("role");
    if (role && ["navigation", "banner", "dialog", "alert", "tooltip"].includes(role)) return true;
    return false;
  }
  function scoreBlock(el) {
    let score = 0;
    const tag = el.tagName;
    const textLen = ownTextLength(el);
    if (SEMANTIC_TAGS.has(tag)) score += 30;
    else if (tag === "DIV") score += 2;
    else score += 5;
    if (textLen === 0) score -= 25;
    else if (textLen < 10) score += 2;
    else if (textLen <= 800) score += 20;
    else if (textLen <= 3e3) score += 8;
    else score -= 15;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    const doc = el.ownerDocument;
    const viewportArea = (doc.defaultView?.innerWidth || 1200) * (doc.defaultView?.innerHeight || 800);
    if (area > 0 && area < viewportArea * 0.6) score += 10;
    else if (area >= viewportArea * 0.9) score -= 20;
    if (isInteractive(el)) score -= 30;
    if (isNavOrOverlay(el)) score -= 15;
    if (tag === "P" || tag === "LI" || /^H[1-6]$/.test(tag) || tag === "BLOCKQUOTE" || tag === "PRE") score += 10;
    return score;
  }
  function liftThroughWrappers(el, exclude) {
    let best = el;
    const text = (el.textContent || "").trim();
    while (!SEMANTIC_TAGS.has(best.tagName)) {
      const parent = best.parentElement;
      if (!parent || SKIP_CONTAINERS.has(parent.tagName) || SEMANTIC_TAGS.has(parent.tagName)) break;
      if ((parent.textContent || "").trim() !== text) break;
      if (exclude(parent) || !isVisible(parent) || isAnnotatorUI(parent)) break;
      best = parent;
    }
    return best;
  }
  function createDefaultBlockResolver() {
    return (target, { exclude }) => {
      let el = target;
      let best = null;
      let bestScore = -Infinity;
      let depth = 0;
      while (el && depth < 12 && !SKIP_CONTAINERS.has(el.tagName)) {
        if (isAnnotatorUI(el)) return null;
        if (!exclude(el) && !CONTROL_TAGS.has(el.tagName) && isVisible(el) && ownTextLength(el) > 0) {
          const score = scoreBlock(el);
          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }
        el = el.parentElement;
        depth++;
      }
      if (!best || bestScore < 10) return null;
      return liftThroughWrappers(best, exclude);
    };
  }

  // src/text-utils.ts
  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function textSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bigrams = /* @__PURE__ */ new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const bg = a.slice(i, i + 2);
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
    let matches = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const bg = b.slice(i, i + 2);
      const count = bigrams.get(bg) || 0;
      if (count > 0) {
        matches++;
        bigrams.set(bg, count - 1);
      }
    }
    return 2 * matches / (a.length + b.length - 2);
  }

  // src/ranges.ts
  var QUOTE_MAX = 300;
  var CONTEXT_CHARS = 32;
  function blockTextWithMap(block) {
    const doc = block.ownerDocument;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node2) {
        const parent = node2.parentElement;
        if (parent?.closest(`[${UI_ATTR}]`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const pieces = [];
    let raw = "";
    let node = walker.nextNode();
    while (node) {
      pieces.push({ node, start: raw.length, end: raw.length + node.data.length });
      raw += node.data;
      node = walker.nextNode();
    }
    let text = "";
    const normToRaw = [];
    const rawToNorm = new Array(raw.length + 1);
    let lastWasSpace = false;
    for (let i = 0; i < raw.length; i++) {
      rawToNorm[i] = text.length;
      const ch = raw[i];
      if (/\s/.test(ch)) {
        if (lastWasSpace || text.length === 0) continue;
        text += " ";
        normToRaw.push(i);
        lastWasSpace = true;
      } else {
        text += ch;
        normToRaw.push(i);
        lastWasSpace = false;
      }
    }
    if (text.endsWith(" ")) {
      text = text.slice(0, -1);
      normToRaw.pop();
    }
    rawToNorm[raw.length] = text.length;
    for (let i = 0; i <= raw.length; i++) {
      if (rawToNorm[i] === void 0) rawToNorm[i] = text.length;
      else rawToNorm[i] = Math.min(rawToNorm[i], text.length);
    }
    return { text, pieces, normToRaw, rawToNorm };
  }
  function rawToNode(map, rawIndex) {
    for (const piece of map.pieces) {
      if (rawIndex >= piece.start && rawIndex < piece.end) {
        return { node: piece.node, offset: rawIndex - piece.start };
      }
    }
    const last = map.pieces[map.pieces.length - 1];
    if (last && rawIndex >= last.end) return { node: last.node, offset: last.node.data.length };
    return null;
  }
  function buildRange(map, start, end) {
    if (start < 0 || end > map.text.length || end <= start) return null;
    const rawStart = map.normToRaw[start];
    const rawEnd = map.normToRaw[end - 1];
    if (rawStart === void 0 || rawEnd === void 0) return null;
    const from = rawToNode(map, rawStart);
    const to = rawToNode(map, rawEnd);
    if (!from || !to) return null;
    const range = from.node.ownerDocument.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, Math.min(to.offset + 1, to.node.data.length));
    return range;
  }
  function rangeOffsets(range, map) {
    let rawStart = Infinity;
    let rawEnd = -Infinity;
    for (const piece of map.pieces) {
      let intersects;
      try {
        intersects = range.intersectsNode(piece.node);
      } catch {
        intersects = true;
      }
      if (!intersects) continue;
      const s = piece.node === range.startContainer ? range.startOffset : 0;
      const e = piece.node === range.endContainer ? range.endOffset : piece.node.data.length;
      if (e <= s) continue;
      rawStart = Math.min(rawStart, piece.start + s);
      rawEnd = Math.max(rawEnd, piece.start + e);
    }
    if (!Number.isFinite(rawStart) || rawEnd < 0) return null;
    const start = map.rawToNorm[rawStart] ?? 0;
    const end = map.rawToNorm[rawEnd] ?? map.text.length;
    if (end <= start) return null;
    return { start, end };
  }
  function createRangeAnchor(range, block, blockAnchor) {
    const map = blockTextWithMap(block);
    const offsets = rangeOffsets(range, map);
    if (!offsets) return blockAnchor;
    const exact = map.text.slice(offsets.start, offsets.end).slice(0, QUOTE_MAX);
    if (!exact.trim()) return blockAnchor;
    return {
      ...blockAnchor,
      kind: "range",
      textQuote: {
        exact,
        prefix: map.text.slice(Math.max(0, offsets.start - CONTEXT_CHARS), offsets.start) || void 0,
        suffix: map.text.slice(offsets.end, offsets.end + CONTEXT_CHARS) || void 0
      },
      textPosition: { start: offsets.start, end: offsets.start + exact.length },
      fingerprint: blockAnchor.fingerprint
    };
  }
  function contextScore(map, at, length, quote) {
    let score = 0;
    if (quote?.prefix) {
      const before = map.text.slice(Math.max(0, at - quote.prefix.length), at);
      if (before === quote.prefix) score++;
    }
    if (quote?.suffix) {
      const after = map.text.slice(at + length, at + length + quote.suffix.length);
      if (after === quote.suffix) score++;
    }
    return score;
  }
  function resolveRangeInBlock(block, anchor) {
    const exact = anchor.textQuote?.exact;
    if (!exact) return null;
    const map = blockTextWithMap(block);
    if (!map.text) return null;
    const pos = anchor.textPosition;
    if (pos && map.text.slice(pos.start, pos.end) === exact) {
      return buildRange(map, pos.start, pos.end);
    }
    const occurrences = [];
    for (let i = map.text.indexOf(exact); i !== -1; i = map.text.indexOf(exact, i + 1)) {
      occurrences.push(i);
      if (occurrences.length > 50) break;
    }
    if (occurrences.length === 1) return buildRange(map, occurrences[0], occurrences[0] + exact.length);
    if (occurrences.length > 1) {
      let best = occurrences[0];
      let bestScore = -Infinity;
      for (const at of occurrences) {
        const score = contextScore(map, at, exact.length, anchor.textQuote) * 1e3 - (pos ? Math.abs(at - pos.start) : 0);
        if (score > bestScore) {
          bestScore = score;
          best = at;
        }
      }
      return buildRange(map, best, best + exact.length);
    }
    const len = exact.length;
    if (len < 4 || map.text.length < 4) return null;
    const coarseStep = Math.max(1, Math.floor(len / 4));
    let bestAt = -1;
    let bestSim = 0;
    for (let at = 0; at + 1 < map.text.length; at += coarseStep) {
      const sim = textSimilarity(map.text.slice(at, at + len), exact);
      if (sim > bestSim) {
        bestSim = sim;
        bestAt = at;
      }
    }
    if (bestAt < 0) return null;
    for (let at = Math.max(0, bestAt - coarseStep); at <= Math.min(map.text.length - 1, bestAt + coarseStep); at++) {
      const sim = textSimilarity(map.text.slice(at, at + len), exact);
      if (sim > bestSim) {
        bestSim = sim;
        bestAt = at;
      }
    }
    if (bestSim < 0.8) return null;
    return buildRange(map, bestAt, Math.min(map.text.length, bestAt + len));
  }

  // src/anchors.ts
  var QUOTE_MAX2 = 300;
  var CONTEXT_MAX = 60;
  var STABLE_ATTRS = ["id", "data-testid", "data-qa", "data-test", "name", "aria-label", "role", "href", "title"];
  function blockText(el) {
    return normalizeText(el.textContent || "");
  }
  function looksGenerated(value) {
    if (/^(css|sc|jsx)-/.test(value)) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(value)) return true;
    if (value.length >= 12 && !/[-_]/.test(value) && /\d/.test(value)) return true;
    return false;
  }
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }
  function buildSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== "HTML" && parts.length < 8) {
      const tag = cur.tagName.toLowerCase();
      const id = cur.getAttribute("id");
      if (id && !/\d{3,}/.test(id) && !looksGenerated(id)) {
        parts.unshift(`#${cssEscape(id)}`);
        break;
      }
      const testAttr = ["data-testid", "data-qa", "data-test"].find((a) => cur.getAttribute(a));
      if (testAttr) {
        parts.unshift(`${tag}[${testAttr}="${cur.getAttribute(testAttr).replace(/"/g, '\\"')}"]`);
        cur = cur.parentElement;
        continue;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : tag);
      } else {
        parts.unshift(tag);
      }
      cur = parent;
    }
    return parts.join(" > ");
  }
  function buildXPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== "HTML") {
      const tag = cur.tagName.toLowerCase();
      let index = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) index++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}[${index}]`);
      cur = cur.parentElement;
    }
    return `/html/${parts.join("/")}`;
  }
  function nearbyHeading(el) {
    let cur = el;
    while (cur && cur.tagName !== "BODY") {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return blockText(sib).slice(0, 120) || void 0;
        const inner = sib.querySelector?.("h1,h2,h3,h4,h5,h6");
        if (inner) return blockText(inner).slice(0, 120) || void 0;
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return void 0;
  }
  function stableAttributes(el) {
    const attrs = {};
    for (const name of STABLE_ATTRS) {
      const value = el.getAttribute(name);
      if (value && value.length <= 200) attrs[name] = value;
    }
    return Object.keys(attrs).length ? attrs : void 0;
  }
  function createAnchor(el, url) {
    const text = blockText(el);
    const exact = text.slice(0, QUOTE_MAX2);
    let prefix;
    let suffix;
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    if (prev) prefix = blockText(prev).slice(-CONTEXT_MAX) || void 0;
    if (next) suffix = blockText(next).slice(0, CONTEXT_MAX) || void 0;
    return {
      url,
      selector: buildSelector(el),
      xpath: buildXPath(el),
      textQuote: exact ? { exact, prefix, suffix } : void 0,
      fingerprint: {
        tag: el.tagName.toLowerCase(),
        text: exact || void 0,
        nearbyHeading: nearbyHeading(el),
        attributes: stableAttributes(el)
      }
    };
  }
  var MAX_CANDIDATES = 2e4;
  function candidateElements(doc, tag) {
    const selector = tag || "article,section,p,li,blockquote,pre,figure,table,h1,h2,h3,h4,h5,h6,dd,dt,td,th,div";
    const all = doc.querySelectorAll(selector);
    const out = [];
    for (const el of all) {
      if ((el.textContent || "").trim().length === 0) continue;
      out.push(el);
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }
  function cachedQuoteText(el, cache) {
    let text = cache.get(el);
    if (text === void 0) {
      text = blockText(el).slice(0, QUOTE_MAX2);
      cache.set(el, text);
    }
    return text;
  }
  function verifyAgainstQuote(el, anchor, cache) {
    if (!anchor.textQuote?.exact) return 0.5;
    return textSimilarity(cachedQuoteText(el, cache), anchor.textQuote.exact);
  }
  function fingerprintScore(el, fp, cache) {
    let score = 0;
    let weight = 0;
    if (fp.text) {
      score += textSimilarity(cachedQuoteText(el, cache), fp.text) * 3;
      weight += 3;
    }
    if (fp.tag) {
      score += el.tagName.toLowerCase() === fp.tag ? 1 : 0;
      weight += 1;
    }
    if (fp.nearbyHeading) {
      const heading = nearbyHeading(el);
      score += heading ? textSimilarity(heading, fp.nearbyHeading) : 0;
      weight += 1;
    }
    if (fp.attributes) {
      const keys = Object.keys(fp.attributes);
      let hit = 0;
      for (const key of keys) if (el.getAttribute(key) === fp.attributes[key]) hit++;
      score += keys.length ? hit / keys.length : 0;
      weight += 1;
    }
    return weight ? score / weight : 0;
  }
  var RESOLVE_THRESHOLD = 0.75;
  var FUZZY_THRESHOLD = 0.6;
  var RANGE_MISS_PENALTY = 0.8;
  function withRange(resolution, anchor) {
    if (resolution.status !== "resolved" || anchor.kind !== "range") return resolution;
    const range = resolveRangeInBlock(resolution.element, anchor);
    if (range) return { ...resolution, range };
    return { ...resolution, confidence: resolution.confidence * RANGE_MISS_PENALTY };
  }
  function resolveAnchor(anchor, doc) {
    const cache = /* @__PURE__ */ new WeakMap();
    if (anchor.selector) {
      try {
        const el = doc.querySelector(anchor.selector);
        if (el) {
          const confidence = verifyAgainstQuote(el, anchor, cache);
          if (confidence >= RESOLVE_THRESHOLD) return withRange({ status: "resolved", element: el, confidence }, anchor);
        }
      } catch {
      }
    }
    if (anchor.xpath && typeof doc.evaluate === "function") {
      try {
        const result = doc.evaluate(anchor.xpath, doc, null, 9, null);
        const el = result.singleNodeValue;
        if (el && el.nodeType === 1) {
          const confidence = verifyAgainstQuote(el, anchor, cache);
          if (confidence >= RESOLVE_THRESHOLD) return withRange({ status: "resolved", element: el, confidence }, anchor);
        }
      } catch {
      }
    }
    const tag = anchor.fingerprint?.tag;
    if (anchor.textQuote?.exact) {
      for (const scoped of [tag, void 0]) {
        const candidates = candidateElements(doc, scoped);
        let best = null;
        for (const el of candidates) {
          if (cachedQuoteText(el, cache) === anchor.textQuote.exact) {
            if (!best || best.contains(el)) best = el;
          }
        }
        if (best) return withRange({ status: "resolved", element: best, confidence: 1 }, anchor);
      }
    }
    if (anchor.fingerprint) {
      const candidates = candidateElements(doc, tag);
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        const score = fingerprintScore(el, anchor.fingerprint, cache);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      if (best && bestScore >= FUZZY_THRESHOLD) {
        return withRange({ status: "resolved", element: best, confidence: bestScore }, anchor);
      }
    }
    return { status: "detached", reason: "no candidate matched with sufficient confidence" };
  }

  // src/archive.ts
  var ARCHIVED_KEY = "archived";
  function isArchived(annotation) {
    return typeof annotation.metadata?.[ARCHIVED_KEY] === "number";
  }
  function archivedAt(annotation) {
    const value = annotation.metadata?.[ARCHIVED_KEY];
    return typeof value === "number" ? value : null;
  }

  // src/commands.ts
  function createCommandRegistry() {
    const commands = /* @__PURE__ */ new Map();
    return {
      register(name, run) {
        commands.set(name, run);
        return () => {
          if (commands.get(name) === run) commands.delete(name);
        };
      },
      execute(name, arg) {
        const run = commands.get(name);
        if (!run) throw new Error(`Unknown command: ${name}`);
        return run(arg);
      },
      has: (name) => commands.has(name),
      list: () => [...commands.keys()].sort()
    };
  }

  // src/dom-utils.ts
  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
  }
  async function copyText(text) {
    const g = globalThis;
    if (typeof g.GM_setClipboard === "function") {
      g.GM_setClipboard(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  // src/events.ts
  var Emitter = class {
    constructor() {
      this.handlers = /* @__PURE__ */ new Map();
    }
    on(event, handler) {
      let set = this.handlers.get(event);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.handlers.set(event, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    }
    emit(event, payload) {
      const set = this.handlers.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[webmods-annotate] "${event}" handler threw`, err);
        }
      }
    }
    clear() {
      this.handlers.clear();
    }
  };
  function generateId() {
    const time = Date.now().toString(36).padStart(9, "0");
    let rand = "";
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      rand = Array.from(bytes, (b) => (b % 36).toString(36)).join("");
    } else {
      while (rand.length < 10) rand += Math.random().toString(36).slice(2);
      rand = rand.slice(0, 10);
    }
    return `${time}${rand}`;
  }

  // src/types.ts
  var SCHEMA_VERSION = 1;
  var NOTE_FRAGMENT_PARAM = "wm-note";
  var INLINE_FRAGMENT_PARAM = "wm";

  // src/page-identity.ts
  var DEFAULT_TRACKING_PARAMS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "ref_src",
    "igshid"
  ];
  function stripOwnFragment(hash) {
    if (!hash) return "";
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const kept = raw.split("&").filter((part) => {
      const key = part.split("=")[0];
      return key !== NOTE_FRAGMENT_PARAM && key !== INLINE_FRAGMENT_PARAM;
    }).join("&");
    return kept ? `#${kept}` : "";
  }
  function normalizeUrl(url, extraStripParams = []) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return url;
    }
    const strip = /* @__PURE__ */ new Set([...DEFAULT_TRACKING_PARAMS, ...extraStripParams]);
    const params = new URLSearchParams(u.search);
    for (const key of [...params.keys()]) {
      if (strip.has(key)) params.delete(key);
    }
    params.sort();
    const search = params.toString();
    u.hash = "";
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${u.origin}${pathname}${search ? `?${search}` : ""}`;
  }
  function hashString(input) {
    let h1 = 3735928559 ^ input.length;
    let h2 = 1103547991 ^ input.length;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).padStart(13, "0");
  }
  function createDefaultPageIdentityResolver(extraStripParams = []) {
    return (location, document2) => {
      const cleanHash = stripOwnFragment(location.hash);
      const url = `${location.origin}${location.pathname}${location.search}${cleanHash}`;
      const normalizedUrl = normalizeUrl(url, extraStripParams);
      return {
        id: `pg_${hashString(normalizedUrl)}`,
        url,
        normalizedUrl,
        title: document2.title || void 0
      };
    };
  }

  // src/storage.ts
  function emptyDB() {
    return { schemaVersion: SCHEMA_VERSION, pages: {} };
  }
  function migrateDB(raw) {
    if (!raw || typeof raw !== "object") return emptyDB();
    const db = raw;
    if (!db.pages || typeof db.pages !== "object") return emptyDB();
    return { schemaVersion: SCHEMA_VERSION, pages: db.pages, settings: db.settings };
  }
  function dbSummaries(db) {
    return Object.values(db.pages).filter((p) => p.annotations.length > 0).map((p) => ({ page: p.identity, count: p.annotations.length }));
  }
  function dbAll(db) {
    return Object.values(db.pages).flatMap((p) => p.annotations);
  }
  var DocumentStorage = class {
    constructor(read, write) {
      this.read = read;
      this.write = write;
    }
    async getPage(page) {
      const db = await this.read();
      return db.pages[page.id]?.annotations.slice() ?? [];
    }
    async get(id) {
      const db = await this.read();
      for (const p of Object.values(db.pages)) {
        const found = p.annotations.find((a) => a.id === id);
        if (found) return found;
      }
      return null;
    }
    async save(annotation, page) {
      const db = await this.read();
      let entry = db.pages[annotation.pageId];
      if (!entry) {
        entry = {
          identity: page ?? { id: annotation.pageId, url: annotation.anchor.url, normalizedUrl: annotation.anchor.url },
          annotations: []
        };
        db.pages[annotation.pageId] = entry;
      } else if (page) {
        entry.identity = page;
      }
      const idx = entry.annotations.findIndex((a) => a.id === annotation.id);
      if (idx >= 0) entry.annotations[idx] = annotation;
      else entry.annotations.push(annotation);
      await this.write(db);
    }
    async delete(id) {
      const db = await this.read();
      let changed = false;
      for (const [pageId, p] of Object.entries(db.pages)) {
        const before = p.annotations.length;
        p.annotations = p.annotations.filter((a) => a.id !== id);
        if (p.annotations.length !== before) changed = true;
        if (p.annotations.length === 0) delete db.pages[pageId];
      }
      if (changed) await this.write(db);
    }
    async listPages() {
      return dbSummaries(await this.read());
    }
    async listAll() {
      return dbAll(await this.read());
    }
    async getSetting(key) {
      const db = await this.read();
      return db.settings?.[key];
    }
    async setSetting(key, value) {
      const db = await this.read();
      db.settings = { ...db.settings, [key]: value };
      await this.write(db);
    }
    /** Full document access for export/import. */
    async exportDB() {
      return await this.read();
    }
    async importDB(db) {
      await this.write(db);
    }
  };
  function createMemoryStorage() {
    let db = emptyDB();
    const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    return new DocumentStorage(
      () => clone(db),
      (next) => {
        db = clone(next);
      }
    );
  }
  var LS_KEY = "wm-annotate:db";
  function createLocalStorageStorage(key = LS_KEY) {
    return new DocumentStorage(
      () => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? migrateDB(JSON.parse(raw)) : emptyDB();
        } catch {
          return emptyDB();
        }
      },
      (db) => {
        localStorage.setItem(key, JSON.stringify(db));
      }
    );
  }
  function detectGM() {
    const g = globalThis;
    if (typeof g.GM_getValue === "function" && typeof g.GM_setValue === "function") {
      return { getValue: g.GM_getValue, setValue: g.GM_setValue };
    }
    if (g.GM && typeof g.GM.getValue === "function" && typeof g.GM.setValue === "function") {
      return { getValue: g.GM.getValue.bind(g.GM), setValue: g.GM.setValue.bind(g.GM) };
    }
    return null;
  }
  var GM_KEY = "wm-annotate:db";
  function createTampermonkeyStorage(key = GM_KEY) {
    const gm = detectGM();
    if (!gm) {
      console.warn("[webmods-annotate] GM storage not available (missing @grant GM_getValue/GM_setValue); falling back to localStorage");
      return createLocalStorageStorage(key);
    }
    return new DocumentStorage(
      async () => {
        try {
          const raw = await gm.getValue(key, null);
          if (!raw) return emptyDB();
          return migrateDB(typeof raw === "string" ? JSON.parse(raw) : raw);
        } catch {
          return emptyDB();
        }
      },
      async (db) => {
        await gm.setValue(key, JSON.stringify(db));
      }
    );
  }
  var IDB_NAME = "wm-annotate";
  var IDB_VERSION = 1;
  function openIDB(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("annotations")) {
          const store = db.createObjectStore("annotations", { keyPath: "id" });
          store.createIndex("pageId", "pageId", { unique: false });
        }
        if (!db.objectStoreNames.contains("pages")) {
          db.createObjectStore("pages", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function createIndexedDBStorage(name = IDB_NAME) {
    let dbPromise = null;
    const db = () => dbPromise ?? (dbPromise = openIDB(name));
    return {
      async getPage(page) {
        const store = (await db()).transaction("annotations").objectStore("annotations");
        return idbRequest(store.index("pageId").getAll(page.id));
      },
      async get(id) {
        const store = (await db()).transaction("annotations").objectStore("annotations");
        return await idbRequest(store.get(id)) ?? null;
      },
      async save(annotation, page) {
        const tx = (await db()).transaction(["annotations", "pages", "meta"], "readwrite");
        tx.objectStore("annotations").put(annotation);
        if (page) tx.objectStore("pages").put(page);
        tx.objectStore("meta").put(SCHEMA_VERSION, "schemaVersion");
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
      async delete(id) {
        const tx = (await db()).transaction("annotations", "readwrite");
        tx.objectStore("annotations").delete(id);
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
      async listPages() {
        const d = await db();
        const pages = await idbRequest(d.transaction("pages").objectStore("pages").getAll());
        const all = await idbRequest(d.transaction("annotations").objectStore("annotations").getAll());
        const counts = /* @__PURE__ */ new Map();
        for (const a of all) counts.set(a.pageId, (counts.get(a.pageId) || 0) + 1);
        return pages.filter((p) => counts.has(p.id)).map((p) => ({ page: p, count: counts.get(p.id) }));
      },
      async listAll() {
        const store = (await db()).transaction("annotations").objectStore("annotations");
        return idbRequest(store.getAll());
      },
      async getSetting(key) {
        const store = (await db()).transaction("meta").objectStore("meta");
        return await idbRequest(store.get(`setting:${key}`));
      },
      async setSetting(key, value) {
        const tx = (await db()).transaction("meta", "readwrite");
        tx.objectStore("meta").put(value, `setting:${key}`);
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
    };
  }

  // src/markdown.ts
  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function safeUrl(url) {
    const trimmed = url.trim();
    if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
    return "#";
  }
  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    out = out.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      return `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return out;
  }
  function renderMarkdown(source) {
    const lines = source.split(/\r?\n/);
    const html = [];
    let list = null;
    let inCode = false;
    const codeLines = [];
    const paragraph = [];
    const closeList = () => {
      if (list) {
        html.push(`</${list}>`);
        list = null;
      }
    };
    const flushParagraph = () => {
      if (paragraph.length) {
        html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
        paragraph.length = 0;
      }
    };
    for (const line of lines) {
      if (inCode) {
        if (/^```/.test(line)) {
          html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
          codeLines.length = 0;
          inCode = false;
        } else {
          codeLines.push(line);
        }
        continue;
      }
      if (/^```/.test(line)) {
        flushParagraph();
        closeList();
        inCode = true;
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushParagraph();
        const kind = ul ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          html.push(`<${kind}>`);
          list = kind;
        }
        html.push(`<li>${inline((ul || ol)[1])}</li>`);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      closeList();
      paragraph.push(line);
    }
    if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    flushParagraph();
    closeList();
    return html.join("\n");
  }

  // src/ui.ts
  var CSS2 = `
:host { all: initial; }
* { box-sizing: border-box; }
.wm-layer {
  position: fixed; inset: 0; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.45; color: #1f2328;
}
.wm-hover {
  position: fixed; pointer-events: none; display: none;
  border: 2px solid #6366f1; border-radius: 4px;
  background: rgba(99, 102, 241, 0.08);
  transition: top 60ms linear, left 60ms linear, width 60ms linear, height 60ms linear;
}
.wm-range {
  position: fixed; pointer-events: none;
  background: rgba(245, 158, 11, 0.28); border-radius: 2px;
}
.wm-flash {
  position: fixed; pointer-events: none;
  border: 2px solid #f59e0b; border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  animation: wm-fade 2.2s ease-out forwards;
}
@keyframes wm-fade { 0%, 55% { opacity: 1; } 100% { opacity: 0; } }
.wm-marker {
  position: fixed; pointer-events: auto; cursor: pointer;
  width: 22px; height: 22px; border-radius: 50%;
  background: #6366f1; color: #fff; border: 2px solid #fff;
  font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 4px rgba(0,0,0,0.35);
}
.wm-marker:hover, .wm-marker:focus-visible { background: #4338ca; outline: 2px solid #c7d2fe; }
.wm-marker.wm-detached { background: #9ca3af; }
.wm-composer {
  position: fixed; pointer-events: auto; z-index: 2;
  width: 320px; max-width: calc(100vw - 24px);
  background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18); padding: 10px;
}
.wm-composer textarea {
  width: 100%; min-height: 90px; resize: vertical;
  font: inherit; font-size: 13px; padding: 6px 8px;
  border: 1px solid #d0d7de; border-radius: 6px;
}
.wm-composer textarea:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
.wm-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.wm-spacer { flex: 1; }
button.wm-btn {
  font: inherit; font-size: 12.5px; cursor: pointer;
  padding: 5px 12px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328;
}
button.wm-btn:hover { background: #eef1f4; }
button.wm-btn:focus-visible { outline: 2px solid #6366f1; }
button.wm-btn.wm-primary { background: #6366f1; border-color: #6366f1; color: #fff; }
button.wm-btn.wm-primary:hover { background: #4f46e5; }
button.wm-btn.wm-danger { color: #d1242f; }
.wm-sidebar {
  position: fixed; top: 0; bottom: 0; width: 340px; max-width: 92vw;
  pointer-events: auto; display: none; flex-direction: column;
  background: #fff; border-left: 1px solid #d0d7de;
  box-shadow: -4px 0 16px rgba(0,0,0,0.12);
}
.wm-sidebar.wm-left { left: 0; right: auto; border-left: 0; border-right: 1px solid #d0d7de; box-shadow: 4px 0 16px rgba(0,0,0,0.12); }
.wm-sidebar.wm-right { right: 0; }
.wm-sidebar.wm-open { display: flex; }
.wm-sidebar-header { position: relative; display: flex; align-items: center; gap: 4px; padding: 10px 12px; border-bottom: 1px solid #d0d7de; }
.wm-header-switch { display: flex; align-items: center; gap: 5px; }
.wm-header-switch > span { font-size: 11.5px; color: #57606a; }
.wm-menu {
  position: absolute; top: 100%; right: 10px; z-index: 3; min-width: 236px;
  background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 4px;
  box-shadow: 0 6px 20px rgba(31,35,40,0.16);
}
.wm-menu button {
  display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; cursor: pointer;
  border: 0; background: none; color: #1f2328; padding: 5px 8px; border-radius: 6px;
}
.wm-menu button:hover { background: #f6f8fa; }
.wm-menu button:focus-visible { outline: 2px solid #6366f1; }
.wm-menu-group { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #57606a; padding: 6px 8px 2px; }
.wm-tab {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border: 0; background: none; padding: 4px 8px; border-radius: 6px; color: #57606a;
}
.wm-tab[aria-selected="true"] { color: #1f2328; background: #eef1f4; }
.wm-tab:focus-visible { outline: 2px solid #6366f1; }
.wm-header-actions { display: flex; gap: 4px; }
button.wm-header-btn { font-size: 11px; padding: 3px 7px; }
.wm-sidebar-body { flex: 1; overflow: auto; padding: 10px 12px; }
.wm-count { font-size: 12px; color: #57606a; margin-bottom: 8px; }
.wm-note {
  border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px;
  cursor: pointer; background: #fff;
}
.wm-note:hover { border-color: #6366f1; }
.wm-note-focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3); transition: box-shadow 300ms; }
.wm-note:focus-visible { outline: 2px solid #6366f1; }
.wm-note-context {
  font-size: 11.5px; color: #57606a; border-left: 3px solid #d0d7de; padding-left: 6px;
  margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wm-note-body { font-size: 13px; word-wrap: break-word; }
.wm-note-body p, .wm-note-body h1, .wm-note-body h2, .wm-note-body h3, .wm-note-body h4, .wm-note-body h5, .wm-note-body h6,
.wm-note-body ul, .wm-note-body ol, .wm-note-body blockquote, .wm-note-body pre { margin: 0 0 6px; }
.wm-note-body h1 { font-size: 16px; } .wm-note-body h2 { font-size: 15px; } .wm-note-body h3 { font-size: 14px; }
.wm-note-body pre { background: #f6f8fa; padding: 6px 8px; border-radius: 6px; overflow: auto; font-size: 12px; }
.wm-note-body code { background: #f6f8fa; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.wm-note-body blockquote { color: #57606a; border-left: 3px solid #d0d7de; padding-left: 8px; }
.wm-note-body a { color: #4f46e5; }
.wm-note-actions { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.wm-note-preview {
  display: block; max-width: 100%; max-height: 140px; margin-top: 6px;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff;
}
.wm-note-actions button { font-size: 11.5px; padding: 3px 8px; }
.wm-badge {
  display: inline-block; font-size: 10.5px; font-weight: 600; border-radius: 999px; padding: 1px 7px; margin-left: 6px;
}
.wm-badge-detached { background: #fff1f0; color: #d1242f; border: 1px solid #ffd7d5; }
.wm-badge-attach { background: #eef1f4; color: #57606a; border: 1px solid #d0d7de; }
.wm-archived > summary { font-size: 12px; color: #57606a; cursor: pointer; margin-bottom: 8px; }
.wm-note-archived { opacity: 0.75; cursor: default; }
.wm-empty { color: #57606a; font-size: 13px; padding: 12px 4px; }
.wm-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wm-corner {
  position: fixed; pointer-events: auto; display: none;
  width: 196px; padding: 8px 10px; gap: 8px;
  background: #fff; border: 1px solid #d0d7de; border-radius: 10px;
  box-shadow: 0 6px 20px rgba(31,35,40,0.16);
}
.wm-corner.wm-corner-open { display: grid; }
.wm-corner-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wm-corner-label { font-size: 12.5px; }
button.wm-switch {
  width: 34px; height: 19px; flex: none; cursor: pointer; position: relative;
  border: 0; border-radius: 999px; background: #d0d7de; padding: 0;
}
button.wm-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px;
  border-radius: 50%; background: #fff; transition: left 120ms;
}
button.wm-switch[aria-checked="true"] { background: #6366f1; }
button.wm-switch[aria-checked="true"]::after { left: 17px; }
button.wm-switch:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
button.wm-corner-sidebar { width: 100%; }
.wm-mode-pill {
  position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
  pointer-events: none; background: #1f2328; color: #fff; font-size: 12px; font-weight: 600;
  padding: 5px 14px; border-radius: 999px; opacity: 0.92; display: none;
}
`;
  var MODE_TEXT_DEFAULT = "Annotate mode \u2014 click a block to add a note (Esc to exit)";
  var CORNER_SIZE = 22;
  var CORNER_DWELL_MS = 250;
  var CORNER_HIDE_MS = 400;
  var MAX_RANGE_RECTS = 50;
  var AnnotatorUI = class {
    constructor(doc, options, noteCallbacks) {
      this.doc = doc;
      this.options = options;
      this.composerEl = null;
      this.composerReturnFocus = null;
      this.markers = /* @__PURE__ */ new Map();
      this.rangeBoxes = [];
      this.hoverTarget = null;
      this.tabs = [{ id: "notes", label: "Notes", render: () => {
      } }];
      this.noteActions = [];
      this.headerActions = [];
      this.activeTab = "notes";
      this.tabCleanup = null;
      this.notes = [];
      this.archived = [];
      this.annotateOn = false;
      this.menuEl = null;
      this.closeMenuListener = null;
      this.cornerEl = null;
      this.cornerTimer = null;
      this.repositionScheduled = false;
      this.listeners = [];
      this.noteCallbacks = noteCallbacks;
      this.host = doc.createElement("div");
      this.host.setAttribute(UI_ATTR, "");
      this.host.style.cssText = `position: fixed; inset: 0; pointer-events: none; z-index: ${options.zIndex};`;
      this.root = this.host.attachShadow({ mode: "open" });
      const style = doc.createElement("style");
      style.textContent = CSS2;
      this.root.appendChild(style);
      this.layer = doc.createElement("div");
      this.layer.className = "wm-layer";
      this.root.appendChild(this.layer);
      this.hoverBox = doc.createElement("div");
      this.hoverBox.className = "wm-hover";
      this.layer.appendChild(this.hoverBox);
      this.modePill = doc.createElement("div");
      this.modePill.className = "wm-mode-pill";
      this.modePill.textContent = MODE_TEXT_DEFAULT;
      this.layer.appendChild(this.modePill);
      this.liveRegion = doc.createElement("div");
      this.liveRegion.className = "wm-sr-only";
      this.liveRegion.setAttribute("aria-live", "polite");
      this.liveRegion.setAttribute("role", "status");
      this.layer.appendChild(this.liveRegion);
      this.sidebar = doc.createElement("aside");
      this.sidebar.className = `wm-sidebar wm-${options.position}`;
      this.sidebar.setAttribute("role", "complementary");
      this.sidebar.setAttribute("aria-label", "Annotations");
      this.tabBar = doc.createElement("div");
      this.tabBar.className = "wm-sidebar-header";
      this.tabBar.setAttribute("role", "tablist");
      this.sidebar.appendChild(this.tabBar);
      this.headerActionsEl = doc.createElement("span");
      this.headerActionsEl.className = "wm-header-actions";
      this.sidebarBody = doc.createElement("div");
      this.sidebarBody.className = "wm-sidebar-body";
      this.sidebar.appendChild(this.sidebarBody);
      this.layer.appendChild(this.sidebar);
      if (options.cornerWidget) this.buildCornerWidget();
      doc.documentElement.appendChild(this.host);
      const reposition = () => this.scheduleReposition();
      doc.addEventListener("scroll", reposition, { capture: true, passive: true });
      this.listeners.push(() => doc.removeEventListener("scroll", reposition, { capture: true }));
      const win = doc.defaultView;
      if (win) {
        win.addEventListener("resize", reposition, { passive: true });
        this.listeners.push(() => win.removeEventListener("resize", reposition));
      }
    }
    /** Annotate-mode switch. Every copy stays in step with the mode via setModeIndicator. */
    makeModeSwitch() {
      const toggle = this.doc.createElement("button");
      toggle.type = "button";
      toggle.className = "wm-switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(this.annotateOn));
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.noteCallbacks.onToggleMode();
      });
      return toggle;
    }
    buildCornerWidget() {
      const corner = this.doc.createElement("div");
      corner.className = "wm-corner";
      corner.setAttribute("role", "group");
      corner.setAttribute("aria-label", "Annotate controls");
      const row = this.doc.createElement("div");
      row.className = "wm-corner-row";
      const label = this.doc.createElement("span");
      label.className = "wm-corner-label";
      label.id = "wm-corner-mode-label";
      label.textContent = "Annotate mode";
      const toggle = this.makeModeSwitch();
      toggle.setAttribute("aria-labelledby", label.id);
      row.append(label, toggle);
      const sidebarBtn = this.makeButton(
        "Notes sidebar",
        "wm-btn wm-primary wm-corner-sidebar",
        () => this.noteCallbacks.onToggleSidebar()
      );
      corner.append(row, sidebarBtn);
      this.layer.appendChild(corner);
      this.cornerEl = corner;
      this.positionCorner();
      const onMove = (e) => this.trackCorner(e.clientX, e.clientY);
      this.doc.addEventListener("pointermove", onMove, { capture: true, passive: true });
      this.listeners.push(() => {
        this.doc.removeEventListener("pointermove", onMove, { capture: true });
        if (this.cornerTimer) clearTimeout(this.cornerTimer);
      });
    }
    /** Bottom-right, clear of the sidebar when that is open on the same side. */
    positionCorner() {
      if (!this.cornerEl) return;
      const clearSidebar = this.options.position === "right" && this.isSidebarOpen();
      this.cornerEl.style.right = clearSidebar ? "352px" : "12px";
      this.cornerEl.style.bottom = "12px";
    }
    trackCorner(x, y) {
      const corner = this.cornerEl;
      if (!corner) return;
      const win = this.doc.defaultView;
      const vw = win?.innerWidth ?? 1200;
      const vh = win?.innerHeight ?? 800;
      const inHotspot = x >= vw - CORNER_SIZE && y >= vh - CORNER_SIZE;
      const open = corner.classList.contains("wm-corner-open");
      const rect = corner.getBoundingClientRect();
      const onPanel = open && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (inHotspot || onPanel) {
        if (this.cornerTimer && open) {
          clearTimeout(this.cornerTimer);
          this.cornerTimer = null;
        }
        if (open || this.cornerTimer) return;
        this.cornerTimer = setTimeout(() => {
          this.cornerTimer = null;
          if (this.doc.fullscreenElement) return;
          this.positionCorner();
          corner.classList.add("wm-corner-open");
        }, CORNER_DWELL_MS);
        return;
      }
      if (!open) {
        if (this.cornerTimer) {
          clearTimeout(this.cornerTimer);
          this.cornerTimer = null;
        }
        return;
      }
      if (this.cornerTimer) return;
      this.cornerTimer = setTimeout(() => {
        this.cornerTimer = null;
        corner.classList.remove("wm-corner-open");
      }, CORNER_HIDE_MS);
    }
    destroy() {
      this.closeMenu();
      for (const off of this.listeners) off();
      this.listeners = [];
      this.tabCleanup?.();
      this.host.remove();
    }
    // -- hover highlight ------------------------------------------------------
    setHoverTarget(el) {
      this.hoverTarget = el;
      if (!el) {
        this.hoverBox.style.display = "none";
        return;
      }
      this.positionBox(this.hoverBox, el);
      this.hoverBox.style.display = "block";
    }
    setModeIndicator(on, text) {
      if (text === void 0) {
        this.annotateOn = on;
        for (const sw of this.root.querySelectorAll(".wm-switch")) sw.setAttribute("aria-checked", String(on));
      }
      this.modePill.textContent = text ?? MODE_TEXT_DEFAULT;
      this.modePill.style.display = on ? "block" : "none";
      this.announce(on ? text ?? "Annotation mode on" : "Annotation mode off");
      if (!on) this.setHoverTarget(null);
    }
    /** Announce a transient message to assistive tech. */
    announce(message) {
      this.liveRegion.textContent = message;
    }
    positionBox(box, target) {
      const rect = target.getBoundingClientRect();
      box.style.top = `${rect.top - 2}px`;
      box.style.left = `${rect.left - 2}px`;
      box.style.width = `${rect.width + 4}px`;
      box.style.height = `${rect.height + 4}px`;
    }
    flash(target) {
      const flash = this.doc.createElement("div");
      flash.className = "wm-flash";
      this.positionBox(flash, target);
      this.layer.appendChild(flash);
      setTimeout(() => flash.remove(), 2300);
    }
    // -- markers --------------------------------------------------------------
    renderNotes(notes, archived = []) {
      this.notes = notes;
      this.archived = archived;
      for (const { el } of this.markers.values()) el.remove();
      this.markers.clear();
      for (const { el } of this.rangeBoxes) el.remove();
      this.rangeBoxes = [];
      for (const note of notes) {
        if (note.resolution.status !== "resolved" || !note.resolution.range) continue;
        const rects = [...note.resolution.range.getClientRects()].slice(0, MAX_RANGE_RECTS);
        for (const rect of rects) {
          if (rect.width < 1 || rect.height < 1) continue;
          const box = this.doc.createElement("div");
          box.className = "wm-range";
          this.layer.appendChild(box);
          this.rangeBoxes.push({ el: box, range: note.resolution.range });
        }
      }
      if (this.options.showMarkers) {
        let index = 0;
        for (const note of notes) {
          if (note.resolution.status !== "resolved") continue;
          index++;
          const marker = this.doc.createElement("button");
          marker.className = "wm-marker";
          marker.type = "button";
          marker.textContent = String(index);
          marker.setAttribute("aria-label", `Annotation ${index}: show note in sidebar`);
          marker.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.focusNote(note.annotation.id);
          });
          this.layer.appendChild(marker);
          this.markers.set(note.annotation.id, { el: marker, target: note.resolution.element });
        }
      }
      this.repositionMarkers();
      this.repositionRanges();
      if (this.activeTab === "notes") this.renderNotesTab();
    }
    scheduleReposition() {
      if (this.repositionScheduled) return;
      this.repositionScheduled = true;
      requestAnimationFrame(() => {
        this.repositionScheduled = false;
        this.repositionMarkers();
        this.repositionRanges();
        if (this.hoverTarget) this.positionBox(this.hoverBox, this.hoverTarget);
      });
    }
    /** Range boxes are laid out per client rect, so wrapped lines each get one. */
    repositionRanges() {
      let i = 0;
      for (const { range } of this.rangeBoxesByRange()) {
        for (const rect of [...range.getClientRects()].slice(0, MAX_RANGE_RECTS)) {
          if (rect.width < 1 || rect.height < 1) continue;
          const box = this.rangeBoxes[i]?.el;
          if (!box) return;
          box.style.top = `${rect.top}px`;
          box.style.left = `${rect.left}px`;
          box.style.width = `${rect.width}px`;
          box.style.height = `${rect.height}px`;
          i++;
        }
      }
    }
    /** Distinct ranges in render order (each may own several boxes). */
    rangeBoxesByRange() {
      const seen = [];
      for (const { range } of this.rangeBoxes) if (!seen.includes(range)) seen.push(range);
      return seen.map((range) => ({ range }));
    }
    repositionMarkers() {
      const win = this.doc.defaultView;
      const vh = win?.innerHeight ?? 800;
      for (const { el, target } of this.markers.values()) {
        const rect = target.getBoundingClientRect();
        const visible = rect.bottom > 0 && rect.top < vh;
        el.style.display = visible ? "flex" : "none";
        if (visible) {
          el.style.top = `${rect.top}px`;
          el.style.left = `${Math.max(4, rect.left - 30)}px`;
        }
      }
    }
    // -- composer -------------------------------------------------------------
    openComposer(target, initialText, canDelete) {
      this.closeComposer();
      return new Promise((resolve) => {
        const composer = this.doc.createElement("div");
        composer.className = "wm-composer";
        composer.setAttribute("role", "dialog");
        composer.setAttribute("aria-label", canDelete ? "Edit annotation" : "New annotation");
        const textarea = this.doc.createElement("textarea");
        textarea.value = initialText;
        textarea.placeholder = "Write a note (Markdown supported)\u2026";
        textarea.setAttribute("aria-label", "Note text");
        composer.appendChild(textarea);
        const row = this.doc.createElement("div");
        row.className = "wm-row";
        const finish = (action) => {
          this.closeComposer();
          resolve({ action, text: textarea.value });
        };
        if (canDelete) {
          const del = this.makeButton("Delete", "wm-btn wm-danger", () => finish("delete"));
          del.setAttribute("aria-label", "Delete note");
          row.appendChild(del);
        }
        const spacer = this.doc.createElement("span");
        spacer.className = "wm-spacer";
        row.appendChild(spacer);
        row.appendChild(this.makeButton("Cancel", "wm-btn", () => finish("cancel")));
        const save = this.makeButton("Save", "wm-btn wm-primary", () => finish("save"));
        row.appendChild(save);
        composer.appendChild(row);
        for (const type of ["keydown", "keyup", "keypress"]) {
          composer.addEventListener(type, (e) => e.stopPropagation());
        }
        composer.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish("cancel");
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            finish("save");
          } else if (e.key === "Tab") {
            const focusables = [...composer.querySelectorAll("textarea, button")];
            if (!focusables.length) return;
            const active = this.root.activeElement;
            const index = active ? focusables.indexOf(active) : -1;
            const next = e.shiftKey ? focusables[(index <= 0 ? focusables.length : index) - 1] : focusables[(index + 1) % focusables.length];
            e.preventDefault();
            next?.focus();
          }
        });
        const rect = target.getBoundingClientRect();
        const win = this.doc.defaultView;
        const vw = win?.innerWidth ?? 1200;
        const vh = win?.innerHeight ?? 800;
        const top = Math.min(Math.max(rect.top, 12), vh - 200);
        const left = Math.min(Math.max(rect.right + 10, 12), vw - 340);
        composer.style.top = `${top}px`;
        composer.style.left = `${left}px`;
        this.layer.appendChild(composer);
        this.composerEl = composer;
        this.composerReturnFocus = this.doc.activeElement;
        textarea.focus();
      });
    }
    closeComposer() {
      this.composerEl?.remove();
      this.composerEl = null;
      const back = this.composerReturnFocus;
      this.composerReturnFocus = null;
      if (back && back.isConnected) back.focus?.({ preventScroll: true });
    }
    hasComposerOpen() {
      return !!this.composerEl;
    }
    makeButton(label, className, onClick) {
      const btn = this.doc.createElement("button");
      btn.type = "button";
      btn.className = className;
      btn.textContent = label;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return btn;
    }
    // -- sidebar --------------------------------------------------------------
    isSidebarOpen() {
      return this.sidebar.classList.contains("wm-open");
    }
    openSidebar() {
      this.sidebar.classList.add("wm-open");
      this.positionCorner();
      this.renderTabs();
      this.activateTab(this.activeTab);
    }
    closeSidebar() {
      this.sidebar.classList.remove("wm-open");
      this.positionCorner();
    }
    /** Open the sidebar on the Notes tab with one note's card scrolled into view and emphasized. */
    focusNote(id) {
      this.activeTab = "notes";
      this.openSidebar();
      const card = this.sidebarBody.querySelector(`.wm-note[data-note-id="${id}"]`);
      if (!(card instanceof HTMLElement)) return;
      card.scrollIntoView?.({ block: "nearest" });
      card.classList.add("wm-note-focus");
      card.focus?.({ preventScroll: true });
      setTimeout(() => card.classList.remove("wm-note-focus"), 1800);
    }
    addNoteAction(action) {
      this.noteActions.push(action);
      this.renderNotesTab();
      return () => {
        this.noteActions = this.noteActions.filter((a) => a !== action);
        this.renderNotesTab();
      };
    }
    addTab(tab) {
      this.tabs.push(tab);
      if (this.isSidebarOpen()) this.renderTabs();
      return () => {
        this.tabs = this.tabs.filter((t) => t !== tab);
        if (this.activeTab === tab.id) this.activateTab("notes");
        if (this.isSidebarOpen()) this.renderTabs();
      };
    }
    renderTabs() {
      this.tabBar.textContent = "";
      this.tabs.forEach((tab, index) => {
        const btn = this.doc.createElement("button");
        btn.className = "wm-tab";
        btn.type = "button";
        btn.setAttribute("role", "tab");
        btn.dataset.tabId = tab.id;
        btn.setAttribute("aria-selected", String(tab.id === this.activeTab));
        btn.tabIndex = tab.id === this.activeTab ? 0 : -1;
        btn.textContent = tab.label;
        btn.addEventListener("click", () => this.activateTab(tab.id));
        btn.addEventListener("keydown", (e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
          e.preventDefault();
          const last = this.tabs.length - 1;
          const next = e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowRight" ? (index + 1) % this.tabs.length : (index - 1 + this.tabs.length) % this.tabs.length;
          this.activateTab(this.tabs[next].id);
          this.tabBar.querySelector(`.wm-tab[data-tab-id="${this.tabs[next].id}"]`)?.focus();
        });
        this.tabBar.appendChild(btn);
      });
      const spacer = this.doc.createElement("span");
      spacer.className = "wm-spacer";
      this.tabBar.appendChild(spacer);
      const modeGroup = this.doc.createElement("span");
      modeGroup.className = "wm-header-switch";
      const modeLabel = this.doc.createElement("span");
      modeLabel.textContent = "Annotate";
      const modeSwitch = this.makeModeSwitch();
      modeSwitch.setAttribute("aria-label", "Annotate mode");
      modeSwitch.title = "Annotate mode (Alt+Shift+A)";
      modeGroup.append(modeLabel, modeSwitch);
      this.tabBar.appendChild(modeGroup);
      this.tabBar.appendChild(this.headerActionsEl);
      this.renderHeaderActions();
      const close = this.makeButton("\u2715", "wm-tab", () => this.closeSidebar());
      close.setAttribute("aria-label", "Close sidebar");
      this.tabBar.appendChild(close);
    }
    addHeaderAction(action) {
      this.headerActions.push(action);
      this.renderHeaderActions();
      return () => {
        this.headerActions = this.headerActions.filter((a) => a !== action);
        this.renderHeaderActions();
      };
    }
    renderHeaderActions() {
      this.closeMenu();
      this.headerActionsEl.textContent = "";
      for (const action of this.headerActions) {
        if (action.tabs && !action.tabs.includes(this.activeTab)) continue;
        const items = action.items;
        const btn = this.makeButton(
          items ? `${action.label} \u25BE` : action.label,
          "wm-btn wm-header-btn",
          () => items ? this.toggleMenu(btn, items()) : action.onClick?.()
        );
        btn.dataset.headerActionId = action.id;
        if (action.title) btn.title = action.title;
        btn.setAttribute("aria-label", action.title ?? action.label);
        if (items) {
          btn.setAttribute("aria-haspopup", "menu");
          btn.setAttribute("aria-expanded", "false");
        }
        this.headerActionsEl.appendChild(btn);
      }
    }
    toggleMenu(owner, items) {
      if (this.menuEl) {
        this.closeMenu();
        return;
      }
      const menu = this.doc.createElement("div");
      menu.className = "wm-menu";
      menu.setAttribute("role", "menu");
      for (const item of items) {
        if (item.group) {
          const head = this.doc.createElement("div");
          head.className = "wm-menu-group";
          head.textContent = item.group;
          menu.appendChild(head);
          continue;
        }
        const entry = this.doc.createElement("button");
        entry.type = "button";
        entry.setAttribute("role", "menuitem");
        entry.textContent = item.label ?? "";
        entry.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.closeMenu();
          item.onClick?.();
        });
        menu.appendChild(entry);
      }
      menu.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        this.closeMenu();
        owner.focus();
      });
      this.tabBar.appendChild(menu);
      this.menuEl = menu;
      owner.setAttribute("aria-expanded", "true");
      const dismiss = (e) => {
        if (e.composedPath().includes(menu) || e.composedPath().includes(owner)) return;
        this.closeMenu();
      };
      this.doc.addEventListener("click", dismiss, true);
      this.closeMenuListener = () => {
        this.doc.removeEventListener("click", dismiss, true);
        owner.setAttribute("aria-expanded", "false");
      };
      menu.querySelector("button")?.focus();
    }
    closeMenu() {
      this.menuEl?.remove();
      this.menuEl = null;
      this.closeMenuListener?.();
      this.closeMenuListener = null;
    }
    /** Switch the sidebar to a tab by id (falls back to Notes for unknown ids). */
    activateTab(id) {
      this.activeTab = this.tabs.some((t) => t.id === id) ? id : "notes";
      this.tabCleanup?.();
      this.tabCleanup = null;
      for (const btn of this.tabBar.querySelectorAll(".wm-tab[role=tab]")) {
        const selected = btn.dataset.tabId === this.activeTab;
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
      }
      this.renderHeaderActions();
      this.sidebarBody.textContent = "";
      if (this.activeTab === "notes") {
        this.renderNotesTab();
      } else {
        const tab = this.tabs.find((t) => t.id === this.activeTab);
        const cleanup = tab?.render(this.sidebarBody);
        if (typeof cleanup === "function") this.tabCleanup = cleanup;
      }
    }
    renderNotesTab() {
      if (this.activeTab !== "notes" || !this.isSidebarOpen()) return;
      this.sidebarBody.textContent = "";
      const count = this.doc.createElement("div");
      count.className = "wm-count";
      count.textContent = `${this.notes.length} note${this.notes.length === 1 ? "" : "s"} on this page`;
      this.sidebarBody.appendChild(count);
      if (!this.notes.length && !this.archived.length) {
        const empty = this.doc.createElement("div");
        empty.className = "wm-empty";
        empty.textContent = "No annotations yet. Enter annotate mode and click a block to add one.";
        this.sidebarBody.appendChild(empty);
        return;
      }
      for (const note of this.notes) this.sidebarBody.appendChild(this.buildNoteCard(note, false));
      if (this.archived.length) {
        const details = this.doc.createElement("details");
        details.className = "wm-archived";
        const summary = this.doc.createElement("summary");
        summary.textContent = `Archived (${this.archived.length})`;
        details.appendChild(summary);
        for (const annotation of this.archived) {
          details.appendChild(this.buildNoteCard({ annotation, resolution: { status: "detached" } }, true));
        }
        this.sidebarBody.appendChild(details);
      }
    }
    /** One sidebar card. Archived cards carry no anchor state, so they only restore or delete. */
    buildNoteCard(note, archivedCard) {
      const card = this.doc.createElement("div");
      card.className = archivedCard ? "wm-note wm-note-archived" : "wm-note";
      card.dataset.noteId = note.annotation.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", archivedCard ? "Archived annotation" : "Go to annotation");
      const detached = note.resolution.status === "detached";
      const context = this.doc.createElement("div");
      context.className = "wm-note-context";
      context.textContent = note.annotation.anchor.textQuote?.exact?.slice(0, 90) || note.annotation.anchor.fingerprint?.tag || "";
      if (detached && !archivedCard) {
        const badge = this.doc.createElement("span");
        badge.className = "wm-badge wm-badge-detached";
        badge.textContent = "detached";
        context.appendChild(badge);
      } else if (note.annotation.anchor.kind === "range" && note.resolution.status === "resolved" && !note.resolution.range) {
        const badge = this.doc.createElement("span");
        badge.className = "wm-badge wm-badge-attach";
        badge.textContent = "text moved";
        context.appendChild(badge);
      }
      if (note.annotation.attachments?.length) {
        const badge = this.doc.createElement("span");
        badge.className = "wm-badge wm-badge-attach";
        badge.textContent = `\u{1F4CE} ${note.annotation.attachments.length}`;
        context.appendChild(badge);
      }
      card.appendChild(context);
      const body = this.doc.createElement("div");
      body.className = "wm-note-body";
      body.innerHTML = renderMarkdown(note.annotation.body.text);
      card.appendChild(body);
      for (const att of note.annotation.attachments ?? []) {
        const preview = att.preview;
        if (typeof preview === "string" && preview.trimStart().startsWith("<svg")) {
          const img = this.doc.createElement("img");
          img.className = "wm-note-preview";
          img.alt = `${att.type} attachment preview`;
          img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(preview)))}`;
          card.appendChild(img);
        }
      }
      const actions = this.doc.createElement("div");
      actions.className = "wm-note-actions";
      const id = note.annotation.id;
      if (archivedCard) {
        actions.appendChild(this.makeButton("Restore", "wm-btn", () => this.noteCallbacks.onUnarchive(id)));
      } else if (!detached) {
        actions.appendChild(this.makeButton("Edit", "wm-btn", () => this.noteCallbacks.onEdit(id)));
      } else {
        actions.appendChild(this.makeButton("Re-attach", "wm-btn", () => this.noteCallbacks.onReattach(id)));
      }
      if (!archivedCard) {
        actions.appendChild(this.makeButton("Copy link", "wm-btn", () => this.noteCallbacks.onCopyLink(id)));
        for (const action of this.noteActions) {
          const label = typeof action.label === "function" ? action.label(note.annotation) : action.label;
          actions.appendChild(this.makeButton(label, "wm-btn", () => action.onClick(note.annotation)));
        }
        actions.appendChild(this.makeButton("Archive", "wm-btn", () => this.noteCallbacks.onArchive(id)));
      }
      actions.appendChild(this.makeButton("Delete", "wm-btn wm-danger", () => this.noteCallbacks.onDelete(id)));
      card.appendChild(actions);
      const navigate = () => {
        if (!detached && !archivedCard) this.noteCallbacks.onNavigate(id);
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        navigate();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate();
        }
      });
      return card;
    }
  };

  // src/annotator.ts
  var DEFAULT_SHORTCUT = "alt+shift+a";
  var DEFAULT_SIDEBAR_SHORTCUT = "alt+shift+s";
  function matchesShortcut(e, shortcut) {
    const parts = shortcut.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    return e.key.toLowerCase() === key && parts.includes("alt") === e.altKey && parts.includes("shift") === e.shiftKey && (parts.includes("ctrl") || parts.includes("control")) === e.ctrlKey && (parts.includes("meta") || parts.includes("cmd")) === e.metaKey;
  }
  function parseNoteFragment(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    for (const part of raw.split("&")) {
      const [key, value] = part.split("=");
      if (key === NOTE_FRAGMENT_PARAM && value) return decodeURIComponent(value);
    }
    return null;
  }
  function createAnnotator(options = {}) {
    const doc = document;
    const win = window;
    const emitter = new Emitter();
    const commands = createCommandRegistry();
    const storage = options.storage ?? createMemoryStorage();
    const resolvePageIdentity = options.pageIdentity ?? createDefaultPageIdentityResolver(options.stripQueryParams);
    const exclude = buildExcludeFn(options.exclude);
    const blockResolver = options.blockResolver ?? createDefaultBlockResolver();
    const uiOptions = {
      sidebar: options.ui?.sidebar !== false,
      position: options.ui?.position ?? "right",
      showMarkers: options.ui?.showMarkers !== false,
      zIndex: options.ui?.zIndex ?? 2147483e3,
      cornerWidget: options.ui?.cornerWidget !== false
    };
    let mode = "explore";
    let page = resolvePageIdentity(win.location, doc);
    let resolved = [];
    let archived = [];
    let destroyed = false;
    const plugins = [];
    const cleanups = [];
    const fail = (error, context) => {
      emitter.emit("error", { error, context });
      options.onError?.(error, context);
      console.error(`[webmods-annotate] ${context ?? "error"}`, error);
    };
    emitter.on("mode:change", ({ mode: mode2 }) => options.onModeChange?.(mode2));
    emitter.on("block:hover", ({ element }) => options.onBlockHover?.(element));
    emitter.on("note:create", ({ annotation }) => options.onCreateNote?.(annotation));
    emitter.on("note:update", ({ annotation }) => options.onUpdateNote?.(annotation));
    emitter.on("note:delete", ({ annotation }) => options.onDeleteNote?.(annotation));
    emitter.on("note:save", ({ annotation }) => options.onSaveNote?.(annotation));
    emitter.on("note:navigate", ({ annotation }) => options.onNavigateToNote?.(annotation));
    emitter.on("anchor:detached", ({ annotation, reason }) => options.onAnchorDetached?.(annotation, reason));
    const ui = new AnnotatorUI(doc, uiOptions, {
      onNavigate: (id) => void scrollToNote(id),
      onEdit: (id) => void editNote(id),
      onDelete: (id) => void deleteNote(id),
      onCopyLink: (id) => void copyNoteLink(id),
      onReattach: (id) => startReanchor(id),
      onArchive: (id) => void setArchived(id, true).catch((err) => fail(err, "archive")),
      onUnarchive: (id) => void setArchived(id, false).catch((err) => fail(err, "unarchive")),
      onToggleMode: () => setMode(mode === "annotate" ? "explore" : "annotate"),
      onToggleSidebar: () => ui.isSidebarOpen() ? ui.closeSidebar() : ui.openSidebar()
    });
    async function refresh() {
      try {
        const nextPage = resolvePageIdentity(win.location, doc);
        if (nextPage.id !== page.id) {
          page = nextPage;
          observerRetries = 0;
          emitter.emit("page:change", { page });
        }
        const annotations = await storage.getPage(page);
        archived = annotations.filter(isArchived);
        resolved = annotations.filter((a) => !isArchived(a)).map((annotation) => {
          const resolution = resolveAnchor(annotation.anchor, doc);
          if (resolution.status === "detached") {
            emitter.emit("anchor:detached", { annotation, reason: resolution.reason });
          }
          return { annotation, resolution };
        });
        ui.renderNotes(resolved, archived);
        ensureObserver();
      } catch (err) {
        fail(err, "refresh");
      }
    }
    const OBSERVER_MAX_RETRIES = 5;
    const OBSERVER_DEBOUNCE_MS = 400;
    let observer = null;
    let observerTimer = null;
    let observerRetries = 0;
    function stopObserver() {
      observer?.disconnect();
      observer = null;
      if (observerTimer) {
        clearTimeout(observerTimer);
        observerTimer = null;
      }
    }
    function ensureObserver() {
      const hasDetached = resolved.some((n) => n.resolution.status === "detached");
      if (destroyed || !hasDetached || observerRetries >= OBSERVER_MAX_RETRIES) {
        stopObserver();
        return;
      }
      if (observer) return;
      observer = new MutationObserver((mutations) => {
        if (mutations.every((m) => m.target instanceof Element && isAnnotatorUI(m.target))) return;
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
          observerTimer = null;
          observerRetries++;
          void refresh();
        }, OBSERVER_DEBOUNCE_MS);
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
    async function createNote(anchor, body) {
      const now = Date.now();
      const annotation = {
        id: generateId(),
        pageId: page.id,
        createdAt: now,
        updatedAt: now,
        anchor,
        body: { type: "markdown", text: body }
      };
      await storage.save(annotation, page);
      emitter.emit("note:create", { annotation });
      emitter.emit("note:save", { annotation });
      await refresh();
      return annotation;
    }
    async function updateNote(id, patch) {
      const existing = await storage.get(id);
      if (!existing) throw new Error(`Annotation not found: ${id}`);
      const annotation = { ...existing, ...patch, id, updatedAt: Date.now() };
      await storage.save(annotation);
      emitter.emit("note:update", { annotation });
      emitter.emit("note:save", { annotation });
      await refresh();
      return annotation;
    }
    async function setArchived(id, on) {
      const existing = await storage.get(id);
      if (!existing) throw new Error(`Annotation not found: ${id}`);
      const metadata = { ...existing.metadata };
      if (on) metadata[ARCHIVED_KEY] = Date.now();
      else delete metadata[ARCHIVED_KEY];
      return updateNote(id, { metadata });
    }
    async function reanchorNote(id, element) {
      const existing = await storage.get(id);
      if (!existing) throw new Error(`Annotation not found: ${id}`);
      const annotation = { ...existing, anchor: createAnchor(element, page.url), updatedAt: Date.now() };
      await storage.save(annotation);
      emitter.emit("note:update", { annotation });
      emitter.emit("note:save", { annotation });
      await refresh();
      return annotation;
    }
    async function deleteNote(id) {
      const existing = await storage.get(id);
      if (!existing) return;
      await storage.delete(id);
      emitter.emit("note:delete", { annotation: existing });
      await refresh();
    }
    async function scrollToNote(id) {
      const note = resolved.find((n) => n.annotation.id === id);
      if (!note) return false;
      if (note.resolution.status !== "resolved") return false;
      const el = note.resolution.element;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => ui.flash(el), 350);
      emitter.emit("note:navigate", { annotation: note.annotation });
      return true;
    }
    function getNoteURL(id) {
      const base = `${win.location.origin}${win.location.pathname}${win.location.search}`;
      const keptHash = stripOwnFragment(win.location.hash);
      const sep = keptHash ? `${keptHash}&` : "#";
      return `${base}${sep}${NOTE_FRAGMENT_PARAM}=${encodeURIComponent(id)}`;
    }
    async function copyNoteLink(id) {
      try {
        await copyText(getNoteURL(id));
      } catch (err) {
        fail(err, "copy-link");
      }
    }
    async function editNote(id) {
      const note = resolved.find((n) => n.annotation.id === id);
      if (!note) return;
      const target = note.resolution.status === "resolved" ? note.resolution.element : doc.body;
      const result = await ui.openComposer(target, note.annotation.body.text, true);
      if (result.action === "save") {
        const text = result.text.trim();
        if (text) await updateNote(id, { body: { type: "markdown", text } });
        else await deleteNote(id);
      } else if (result.action === "delete") {
        await deleteNote(id);
      }
    }
    async function composeAt(target, range) {
      const blockAnchor = createAnchor(target, page.url);
      const anchor = range ? createRangeAnchor(range, target, blockAnchor) : blockAnchor;
      const result = await ui.openComposer(target, "", false);
      if (result.action === "save" && result.text.trim()) {
        await createNote(anchor, result.text.trim());
      }
    }
    function selectionRange() {
      const selection = win.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      if (!range.toString().trim()) return null;
      const container = range.commonAncestorContainer;
      const el = container instanceof Element ? container : container.parentElement;
      if (!el || isAnnotatorUI(el)) return null;
      const block = blockResolver(el, { exclude });
      if (!block || !block.contains(range.commonAncestorContainer)) return null;
      return { range, block };
    }
    function setMode(next) {
      if (mode === next || destroyed) return;
      mode = next;
      ui.setModeIndicator(next === "annotate");
      if (next === "explore") {
        ui.closeComposer();
        emitter.emit("block:hover", { element: null });
      }
      emitter.emit("mode:change", { mode: next });
    }
    let reanchoringId = null;
    function startReanchor(id) {
      if (destroyed) return;
      reanchoringId = id;
      ui.setModeIndicator(true, "Pick a new block for this note (Esc to cancel)");
    }
    function cancelReanchor() {
      if (!reanchoringId) return;
      reanchoringId = null;
      hoverEl = null;
      ui.setHoverTarget(null);
      ui.setModeIndicator(mode === "annotate");
    }
    const picking = () => mode === "annotate" || reanchoringId !== null;
    let hoverEl = null;
    let pendingHoverTarget = null;
    let hoverFrame = 0;
    function onPointerMove(e) {
      if (!picking() || ui.hasComposerOpen()) return;
      if (e.buttons & 1) return;
      const target = e.target;
      if (!target || !(target instanceof Element)) return;
      pendingHoverTarget = target;
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const candidate = pendingHoverTarget;
        pendingHoverTarget = null;
        if (!candidate || !picking() || ui.hasComposerOpen()) return;
        const block = isAnnotatorUI(candidate) ? null : blockResolver(candidate, { exclude });
        if (block !== hoverEl) {
          hoverEl = block;
          ui.setHoverTarget(block);
          emitter.emit("block:hover", { element: block });
        }
      });
    }
    function onClick(e) {
      if (!picking() || ui.hasComposerOpen()) return;
      const target = e.target;
      if (!target || !(target instanceof Element) || isAnnotatorUI(target)) return;
      if (!reanchoringId) {
        const picked = selectionRange();
        if (picked) {
          e.preventDefault();
          e.stopPropagation();
          ui.setHoverTarget(null);
          void composeAt(picked.block, picked.range);
          return;
        }
      }
      const block = hoverEl ?? blockResolver(target, { exclude });
      if (!block) return;
      e.preventDefault();
      e.stopPropagation();
      ui.setHoverTarget(null);
      if (reanchoringId) {
        const id = reanchoringId;
        cancelReanchor();
        void reanchorNote(id, block).then(() => ui.focusNote(id)).catch((err) => fail(err, "reanchor"));
        return;
      }
      void composeAt(block);
    }
    function onKeydown(e) {
      if (e.key === "Escape" && !ui.hasComposerOpen()) {
        if (reanchoringId) {
          cancelReanchor();
          return;
        }
        if (mode === "annotate") {
          setMode("explore");
          return;
        }
        if (ui.isSidebarOpen()) {
          ui.closeSidebar();
          return;
        }
      }
      const target = e.target;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable && !inDocumentEditor(target));
      if (typing) return;
      const toggleShortcut = options.shortcuts?.toggle === void 0 ? DEFAULT_SHORTCUT : options.shortcuts.toggle;
      if (toggleShortcut && matchesShortcut(e, toggleShortcut)) {
        e.preventDefault();
        setMode(mode === "annotate" ? "explore" : "annotate");
        return;
      }
      const sidebarShortcut = options.shortcuts?.sidebar === void 0 ? DEFAULT_SIDEBAR_SHORTCUT : options.shortcuts.sidebar;
      if (sidebarShortcut && matchesShortcut(e, sidebarShortcut)) {
        e.preventDefault();
        commands.execute("sidebar.toggle");
      }
    }
    doc.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKeydown, true);
    cleanups.push(() => {
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      doc.removeEventListener("pointermove", onPointerMove, { capture: true });
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKeydown, true);
    });
    async function handleNoteFragment() {
      const noteId = parseNoteFragment(win.location.hash);
      if (!noteId) return;
      try {
        const annotation = await storage.get(noteId);
        if (!annotation) return;
        await refresh();
        if (uiOptions.sidebar) ui.focusNote(noteId);
        await scrollToNote(noteId);
      } catch (err) {
        fail(err, "note-fragment");
      }
    }
    const onHashChange = () => void handleNoteFragment();
    const onPopState = () => void refresh();
    win.addEventListener("hashchange", onHashChange);
    win.addEventListener("popstate", onPopState);
    cleanups.push(() => {
      win.removeEventListener("hashchange", onHashChange);
      win.removeEventListener("popstate", onPopState);
    });
    const history = win.history;
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function(...args) {
      origPush(...args);
      void refresh();
    };
    history.replaceState = function(...args) {
      origReplace(...args);
      void refresh();
    };
    cleanups.push(() => {
      history.pushState = origPush;
      history.replaceState = origReplace;
    });
    function makePluginContext() {
      return {
        annotator: api,
        storage,
        commands,
        on: (event, handler) => emitter.on(event, handler),
        addSidebarTab: (tab) => ui.addTab(tab),
        addNoteAction: (action) => ui.addNoteAction(action),
        addHeaderAction: (action) => ui.addHeaderAction(action),
        activateSidebarTab: (id) => {
          ui.openSidebar();
          ui.activateTab(id);
        },
        getPage: () => page,
        getNotes: () => resolved.slice(),
        scrollToNote
      };
    }
    commands.register("annotate.enter", () => setMode("annotate"));
    commands.register("annotate.exit", () => setMode("explore"));
    commands.register("annotate.toggle", () => setMode(mode === "annotate" ? "explore" : "annotate"));
    commands.register("sidebar.toggle", () => ui.isSidebarOpen() ? ui.closeSidebar() : ui.openSidebar());
    commands.register("note.delete", (id) => deleteNote(String(id)));
    commands.register("note.scroll-to", (id) => scrollToNote(String(id)));
    commands.register("note.copy-link", (id) => copyNoteLink(String(id)));
    commands.register("note.edit", (id) => editNote(String(id)));
    commands.register("note.reattach", (id) => startReanchor(String(id)));
    commands.register("note.archive", (id) => setArchived(String(id), true));
    commands.register("note.unarchive", (id) => setArchived(String(id), false));
    const api = {
      enter: () => setMode("annotate"),
      exit: () => setMode("explore"),
      toggle: () => setMode(mode === "annotate" ? "explore" : "annotate"),
      getMode: () => mode,
      refresh,
      getPage: () => page,
      getNotes: () => resolved.slice(),
      createNote,
      updateNote,
      reanchorNote,
      deleteNote,
      archiveNote: (id) => setArchived(id, true),
      unarchiveNote: (id) => setArchived(id, false),
      getArchivedNotes: () => archived.slice(),
      getNote: (id) => storage.get(id),
      getPageNotes: (p) => storage.getPage(p ?? page),
      scrollToNote,
      getNoteURL,
      openSidebar: () => ui.openSidebar(),
      closeSidebar: () => ui.closeSidebar(),
      toggleSidebar: () => ui.isSidebarOpen() ? ui.closeSidebar() : ui.openSidebar(),
      use(plugin) {
        plugins.push(plugin);
        Promise.resolve(plugin.setup(makePluginContext())).catch((err) => fail(err, `plugin:${plugin.name}`));
        return api;
      },
      on: (event, handler) => emitter.on(event, handler),
      commands,
      storage,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        setMode("explore");
        for (const plugin of plugins) {
          Promise.resolve(plugin.destroy?.()).catch((err) => fail(err, `plugin-destroy:${plugin.name}`));
        }
        stopObserver();
        for (const off of cleanups) off();
        ui.destroy();
        emitter.clear();
      }
    };
    void refresh().then(handleNoteFragment);
    return api;
  }

  // src/plugins/portable-data.ts
  var INLINE_MAX_BYTES = 4096;
  function validateAnnotation(value) {
    if (!value || typeof value !== "object") return false;
    const a = value;
    return typeof a.id === "string" && typeof a.pageId === "string" && typeof a.createdAt === "number" && typeof a.updatedAt === "number" && !!a.anchor && typeof a.anchor === "object" && typeof a.anchor.url === "string" && !!a.body && a.body.type === "markdown" && typeof a.body.text === "string";
  }
  function validateExportDocument(value) {
    if (!value || typeof value !== "object") return false;
    const doc = value;
    if (doc.format !== "wm-annotate-export") return false;
    if (typeof doc.schemaVersion !== "number" || doc.schemaVersion > SCHEMA_VERSION) return false;
    if (!Array.isArray(doc.pages)) return false;
    return doc.pages.every(
      (p) => p && typeof p === "object" && p.identity && typeof p.identity.id === "string" && Array.isArray(p.annotations) && p.annotations.every(validateAnnotation)
    );
  }
  function base64UrlEncode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlDecode(encoded) {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  async function collectPages(storage, currentPage) {
    if (storage.listAll && storage.listPages) {
      const [all, summaries] = await Promise.all([storage.listAll(), storage.listPages()]);
      const identities = new Map(summaries.map((s) => [s.page.id, s.page]));
      const byPage = /* @__PURE__ */ new Map();
      for (const a of all) {
        const list = byPage.get(a.pageId) ?? [];
        list.push(a);
        byPage.set(a.pageId, list);
      }
      return [...byPage.entries()].map(([pageId, annotations]) => ({
        identity: identities.get(pageId) ?? {
          id: pageId,
          url: annotations[0]?.anchor.url ?? "",
          normalizedUrl: annotations[0]?.anchor.url ?? ""
        },
        annotations
      }));
    }
    return [{ identity: currentPage, annotations: await storage.getPage(currentPage) }];
  }
  function hostOf(url) {
    try {
      return new URL(url).host || null;
    } catch {
      return null;
    }
  }
  function filterPagesByScope(pages, current, scope) {
    if (scope === "all") return pages;
    if (scope === "page") return pages.filter((p) => p.identity.id === current.id);
    const host = hostOf(current.normalizedUrl) ?? hostOf(current.url);
    if (!host) return pages.filter((p) => p.identity.id === current.id);
    return pages.filter((p) => (hostOf(p.identity.normalizedUrl) ?? hostOf(p.identity.url)) === host);
  }
  function exportFilename(scope, current, extension, today = /* @__PURE__ */ new Date()) {
    const host = scope === "all" ? "all" : hostOf(current.normalizedUrl) ?? hostOf(current.url) ?? "page";
    return `webmods-annotations-${host}-${today.toISOString().slice(0, 10)}.${extension}`;
  }
  function pageSection(identity, annotations, level = 1) {
    const hash = "#".repeat(level);
    const lines = [`${hash} ${identity.title || identity.normalizedUrl}`, "", `Source: ${identity.url}`];
    for (const a of [...annotations].sort((x, y) => x.createdAt - y.createdAt)) {
      lines.push("");
      const heading = a.anchor.fingerprint?.nearbyHeading || a.anchor.textQuote?.exact?.slice(0, 60) || "Note";
      lines.push(`${hash}# ${heading}`);
      lines.push("");
      if (a.anchor.textQuote?.exact) {
        lines.push(`> ${a.anchor.textQuote.exact.slice(0, 200)}`);
        lines.push("");
      }
      lines.push(a.body.text);
      for (const att of a.attachments ?? []) {
        lines.push("");
        lines.push(`Attachment: ${att.id}.${att.type}`);
      }
    }
    return lines.join("\n");
  }
  function createPortableDataPlugin() {
    let ctx = null;
    const cleanups = [];
    const requireCtx = () => {
      if (!ctx) throw new Error("portable-data plugin is not attached to an annotator (call annotator.use(plugin) first)");
      return ctx;
    };
    async function collectOwnPages(scope = "all") {
      const { storage, getPage } = requireCtx();
      const current = getPage();
      return filterPagesByScope(await collectPages(storage, current), current, scope);
    }
    const plugin = {
      name: "portable-data",
      setup(pluginCtx) {
        ctx = pluginCtx;
        pluginCtx.commands.register("export.json", (opts) => plugin.exportJSON(opts));
        pluginCtx.commands.register("export.markdown", (opts) => plugin.exportMarkdown(opts));
        pluginCtx.commands.register("import.json", (data) => plugin.importJSON(data));
        cleanups.push(
          pluginCtx.addHeaderAction({
            id: "export",
            label: "Export",
            title: "Export notes",
            items: () => {
              const host = hostOf(pluginCtx.getPage().normalizedUrl);
              const named = host ? ` (${host})` : "";
              const entries = [{ group: `This site${named}` }];
              for (const [scope, where] of [
                ["site", `this site${named}`],
                ["all", "all sites"]
              ]) {
                if (scope === "all") entries.push({ group: "All sites" });
                entries.push(
                  { label: `Markdown, ${where}`, onClick: () => void plugin.downloadExport("markdown", { scope }) },
                  { label: `JSON, ${where}`, onClick: () => void plugin.downloadExport("json", { scope }) }
                );
              }
              return entries;
            }
          })
        );
      },
      destroy() {
        for (const off of cleanups.splice(0)) off();
        ctx = null;
      },
      async exportJSON(opts = {}) {
        return {
          format: "wm-annotate-export",
          schemaVersion: SCHEMA_VERSION,
          exportedAt: Date.now(),
          pages: await collectOwnPages(opts.scope ?? "all")
        };
      },
      async downloadExport(format, opts = {}) {
        const scope = opts.scope ?? "all";
        const name = exportFilename(scope, requireCtx().getPage(), format === "json" ? "json" : "md");
        if (format === "json") {
          download(name, JSON.stringify(await plugin.exportJSON(opts), null, 2), "application/json");
        } else {
          download(name, await plugin.exportMarkdown(opts), "text/markdown");
        }
      },
      async importJSON(data, strategy = "skip") {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        if (!validateExportDocument(parsed)) {
          throw new Error("Invalid annotation export document");
        }
        const { storage, annotator } = requireCtx();
        const result = { imported: 0, skipped: 0, replaced: 0 };
        for (const pageEntry of parsed.pages) {
          for (const annotation of pageEntry.annotations) {
            const existing = await storage.get(annotation.id);
            if (!existing) {
              await storage.save(annotation, pageEntry.identity);
              result.imported++;
              continue;
            }
            switch (strategy) {
              case "skip":
                result.skipped++;
                break;
              case "replace":
                await storage.save(annotation, pageEntry.identity);
                result.replaced++;
                break;
              case "merge":
                if (annotation.updatedAt > existing.updatedAt) {
                  await storage.save(annotation, pageEntry.identity);
                  result.replaced++;
                } else {
                  result.skipped++;
                }
                break;
              case "duplicate": {
                const copy = { ...annotation, id: `${annotation.id}-imported-${Date.now().toString(36)}` };
                await storage.save(copy, pageEntry.identity);
                result.imported++;
                break;
              }
            }
          }
        }
        await annotator.refresh();
        return result;
      },
      async exportMarkdown(opts = {}) {
        const pages = await collectOwnPages(opts.scope ?? "all");
        const sections = [];
        for (const { identity, annotations } of pages) {
          const active = annotations.filter((a) => !isArchived(a));
          if (!active.length) continue;
          sections.push(pageSection(identity, active));
        }
        const archived = pages.map(({ identity, annotations }) => ({ identity, annotations: annotations.filter(isArchived) })).filter((p) => p.annotations.length);
        if (archived.length) {
          const lines = ["# Archived"];
          for (const { identity, annotations } of archived) {
            lines.push("");
            lines.push(pageSection(identity, annotations, 2));
          }
          sections.push(lines.join("\n"));
        }
        return sections.join("\n\n---\n\n") + "\n";
      },
      createInlineURL(annotation, page) {
        const payload = JSON.stringify({ v: 1, page, annotation });
        const encoded = base64UrlEncode(payload);
        if (encoded.length > INLINE_MAX_BYTES) {
          throw new Error(`Annotation too large for inline URL (${encoded.length} > ${INLINE_MAX_BYTES} bytes)`);
        }
        return `${page.url.split("#")[0]}#${INLINE_FRAGMENT_PARAM}=${encoded}`;
      },
      parseInlineFragment(hash) {
        const raw = hash.startsWith("#") ? hash.slice(1) : hash;
        for (const part of raw.split("&")) {
          const [key, ...rest] = part.split("=");
          if (key !== INLINE_FRAGMENT_PARAM || !rest.length) continue;
          try {
            const payload = JSON.parse(base64UrlDecode(rest.join("=")));
            if (payload?.v === 1 && validateAnnotation(payload.annotation) && payload.page?.id) {
              return { page: payload.page, annotation: payload.annotation };
            }
          } catch {
            return null;
          }
        }
        return null;
      }
    };
    return plugin;
  }

  // src/plugins/global-browser.ts
  var MAX_RESULTS = 5e3;
  function hostOf2(url) {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }
  function parseQuery(query) {
    const tokens = [];
    const sites = [];
    for (const raw of query.toLowerCase().split(/\s+/)) {
      if (!raw) continue;
      if (raw.startsWith("site:")) {
        const value = raw.slice("site:".length);
        if (value) sites.push(value);
      } else {
        tokens.push(raw);
      }
    }
    return { tokens, sites };
  }
  var FIELD_ORDER = ["body", "quote", "url", "title"];
  function fieldValues(page, annotation) {
    return {
      body: annotation.body.text.toLowerCase(),
      quote: (annotation.anchor.textQuote?.exact ?? "").toLowerCase(),
      url: page.normalizedUrl.toLowerCase(),
      title: (page.title ?? "").toLowerCase()
    };
  }
  function searchAnnotations(pages, query) {
    const { tokens, sites } = parseQuery(query);
    const results = [];
    for (const { identity, annotations } of pages) {
      if (sites.length && !sites.every((s) => hostOf2(identity.normalizedUrl).includes(s))) continue;
      for (const annotation of annotations) {
        const values = fieldValues(identity, annotation);
        const matchesAll = tokens.every((token) => FIELD_ORDER.some((field) => values[field].includes(token)));
        if (!matchesAll) continue;
        const first = tokens[0];
        const matched = first ? FIELD_ORDER.find((field) => values[field].includes(first)) ?? "body" : "body";
        results.push({ page: identity, annotation, matched });
      }
    }
    return results.sort((a, b) => {
      const byPage = a.page.normalizedUrl.localeCompare(b.page.normalizedUrl);
      if (byPage !== 0) return byPage;
      return b.annotation.updatedAt - a.annotation.updatedAt;
    });
  }
  function noteLink(annotation) {
    const base = annotation.anchor.url.split("#")[0];
    return `${base}#${NOTE_FRAGMENT_PARAM}=${encodeURIComponent(annotation.id)}`;
  }
  function formatDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  var CSS3 = `
.wm-gb { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.wm-gb input {
  font: inherit; font-size: 13px; padding: 5px 8px; width: 100%;
  border: 1px solid #d0d7de; border-radius: 6px;
}
.wm-gb input:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
.wm-gb-summary { font-size: 12px; color: #57606a; }
.wm-gb-controls { display: flex; align-items: center; gap: 6px; }
.wm-gb-controls label { font-size: 12px; color: #57606a; }
.wm-gb-list { flex: 1; overflow: auto; }
.wm-gb-site { margin-bottom: 10px; }
.wm-gb-site-head { display: flex; align-items: center; gap: 6px; padding: 2px 0 6px; }
.wm-gb-site-toggle {
  display: flex; align-items: center; gap: 6px; flex: 1; text-align: left;
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  border: 0; background: none; color: #1f2328; padding: 0;
}
.wm-gb-site-toggle:focus-visible { outline: 2px solid #6366f1; }
.wm-gb-site-count { font-size: 11px; font-weight: 400; color: #57606a; }
.wm-gb-page { border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
.wm-gb-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #f6f8fa; }
.wm-gb-toggle {
  font: inherit; font-size: 12.5px; font-weight: 600; text-align: left; flex: 1;
  border: 0; background: none; cursor: pointer; color: #1f2328; padding: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wm-gb-toggle:focus-visible { outline: 2px solid #6366f1; }
.wm-gb-host { font-size: 11px; color: #57606a; font-weight: 400; }
.wm-gb-count { font-size: 11px; color: #57606a; }
.wm-gb-export {
  font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328;
}
.wm-gb-note {
  display: block; width: 100%; text-align: left; font: inherit; cursor: pointer;
  border: 0; border-top: 1px solid #d0d7de; background: #fff; padding: 7px 9px;
}
.wm-gb-note:hover { background: #f6f8fa; }
.wm-gb-note:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
.wm-gb-excerpt { font-size: 12.5px; color: #1f2328; }
.wm-gb-context { font-size: 11px; color: #57606a; margin-top: 3px; }
.wm-gb-empty, .wm-gb-warn { font-size: 12.5px; color: #57606a; padding: 8px 2px; }
`;
  function createGlobalBrowserPlugin() {
    let ctx = null;
    const cleanups = [];
    let render = null;
    let groupBySite = false;
    const requireCtx = () => {
      if (!ctx) throw new Error("global-browser plugin is not attached to an annotator (call annotator.use(plugin) first)");
      return ctx;
    };
    const supported = (c) => !!(c.storage.listAll && c.storage.listPages);
    async function search(query) {
      const c = requireCtx();
      if (!supported(c)) return [];
      return searchAnnotations(await collectPages(c.storage, c.getPage()), query);
    }
    function exportDocument(groups, slug) {
      const doc = {
        format: "wm-annotate-export",
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        pages: groups
      };
      download(`webmods-annotations-${slug || "page"}.json`, JSON.stringify(doc, null, 2), "application/json");
    }
    function exportPage(group) {
      const slug = (group.identity.title || hostOf2(group.identity.normalizedUrl) || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      exportDocument([group], slug);
    }
    const plugin = {
      name: "global-browser",
      setup(pluginCtx) {
        ctx = pluginCtx;
        cleanups.push(pluginCtx.commands.register("browser.search", (query) => search(String(query ?? ""))));
        cleanups.push(pluginCtx.commands.register("browser.open", () => pluginCtx.activateSidebarTab("all-pages")));
        cleanups.push(
          pluginCtx.addSidebarTab({
            id: "all-pages",
            label: "All pages",
            render(container) {
              const style = document.createElement("style");
              style.textContent = CSS3;
              container.appendChild(style);
              const root = document.createElement("div");
              root.className = "wm-gb";
              container.appendChild(root);
              if (!supported(pluginCtx)) {
                const note = document.createElement("div");
                note.className = "wm-gb-empty";
                note.textContent = "This storage adapter does not support browsing all pages.";
                root.appendChild(note);
                return () => {
                };
              }
              const input = document.createElement("input");
              input.type = "search";
              input.setAttribute("aria-label", "Search all annotations");
              input.placeholder = "Search notes\u2026 (site:example.com to filter)";
              const summary = document.createElement("div");
              summary.className = "wm-gb-summary";
              const controls = document.createElement("div");
              controls.className = "wm-gb-controls";
              const groupLabel = document.createElement("label");
              groupLabel.id = "wm-gb-group-label";
              groupLabel.textContent = "Group by site";
              const groupSwitch = document.createElement("button");
              groupSwitch.type = "button";
              groupSwitch.className = "wm-switch";
              groupSwitch.setAttribute("role", "switch");
              groupSwitch.setAttribute("aria-labelledby", groupLabel.id);
              groupSwitch.setAttribute("aria-checked", String(groupBySite));
              groupSwitch.addEventListener("click", () => {
                groupBySite = !groupBySite;
                groupSwitch.setAttribute("aria-checked", String(groupBySite));
                void paint();
              });
              controls.append(groupLabel, groupSwitch);
              const list = document.createElement("div");
              list.className = "wm-gb-list";
              root.append(input, summary, controls, list);
              const collapsed = /* @__PURE__ */ new Set();
              let generation = 0;
              const paint = async () => {
                const mine = ++generation;
                const query = input.value.trim();
                let pages;
                try {
                  pages = await collectPages(pluginCtx.storage, pluginCtx.getPage());
                } catch {
                  return;
                }
                if (mine !== generation) return;
                const results = searchAnnotations(pages, query);
                const shown = results.slice(0, MAX_RESULTS);
                const byPage = /* @__PURE__ */ new Map();
                for (const r of shown) {
                  const bucket = byPage.get(r.page.id) ?? [];
                  bucket.push(r);
                  byPage.set(r.page.id, bucket);
                }
                summary.textContent = `${results.length} note${results.length === 1 ? "" : "s"} on ${byPage.size} page${byPage.size === 1 ? "" : "s"}`;
                list.textContent = "";
                if (results.length > shown.length) {
                  const warn = document.createElement("div");
                  warn.className = "wm-gb-warn";
                  warn.textContent = `Showing ${shown.length} of ${results.length} notes \u2014 refine your search.`;
                  list.appendChild(warn);
                }
                if (!shown.length) {
                  const empty = document.createElement("div");
                  empty.className = "wm-gb-empty";
                  empty.textContent = query ? "No notes match that search." : "No annotations stored yet.";
                  list.appendChild(empty);
                  return;
                }
                const collapseByDefault = !query && byPage.size > 5;
                const buildPageCard = (pageId, group) => {
                  const identity = group[0].page;
                  const card = document.createElement("div");
                  card.className = "wm-gb-page";
                  card.dataset.pageId = pageId;
                  const head = document.createElement("div");
                  head.className = "wm-gb-head";
                  const isCollapsed = collapsed.has(pageId) || collapseByDefault && !collapsed.has(`open:${pageId}`);
                  const toggle = document.createElement("button");
                  toggle.type = "button";
                  toggle.className = "wm-gb-toggle";
                  toggle.setAttribute("aria-expanded", String(!isCollapsed));
                  toggle.textContent = identity.title || identity.normalizedUrl;
                  if (!groupBySite) {
                    const host = document.createElement("span");
                    host.className = "wm-gb-host";
                    host.textContent = ` \u2014 ${hostOf2(identity.normalizedUrl)}`;
                    toggle.appendChild(host);
                  }
                  toggle.addEventListener("click", () => {
                    if (collapsed.has(pageId)) {
                      collapsed.delete(pageId);
                      collapsed.add(`open:${pageId}`);
                    } else {
                      collapsed.add(pageId);
                      collapsed.delete(`open:${pageId}`);
                    }
                    void paint();
                  });
                  const count = document.createElement("span");
                  count.className = "wm-gb-count";
                  count.textContent = `${group.length}`;
                  const exportBtn = document.createElement("button");
                  exportBtn.type = "button";
                  exportBtn.className = "wm-gb-export";
                  exportBtn.textContent = "Export";
                  exportBtn.setAttribute("aria-label", `Export annotations for ${identity.title || identity.normalizedUrl}`);
                  exportBtn.addEventListener("click", () => {
                    const full = pages.find((p) => p.identity.id === pageId);
                    if (full) exportPage(full);
                  });
                  head.append(toggle, count, exportBtn);
                  card.appendChild(head);
                  if (!isCollapsed) {
                    for (const { annotation } of group) {
                      const row = document.createElement("button");
                      row.type = "button";
                      row.className = "wm-gb-note";
                      row.dataset.noteId = annotation.id;
                      const excerpt = document.createElement("div");
                      excerpt.className = "wm-gb-excerpt";
                      excerpt.textContent = annotation.body.text.slice(0, 120);
                      const context = document.createElement("div");
                      context.className = "wm-gb-context";
                      const quote = annotation.anchor.textQuote?.exact;
                      const state = isArchived(annotation) ? "archived \xB7 " : "";
                      context.textContent = `${state}${formatDate(annotation.updatedAt)}${quote ? ` \xB7 ${quote.slice(0, 60)}` : ""}`;
                      row.append(excerpt, context);
                      row.addEventListener("click", () => {
                        if (pageId === pluginCtx.getPage().id) {
                          pluginCtx.activateSidebarTab("notes");
                          void pluginCtx.scrollToNote(annotation.id);
                        } else {
                          window.open(noteLink(annotation), "_blank", "noopener");
                        }
                      });
                      card.appendChild(row);
                    }
                  }
                  return card;
                };
                if (!groupBySite) {
                  for (const [pageId, group] of byPage) list.appendChild(buildPageCard(pageId, group));
                  return;
                }
                const bySite = /* @__PURE__ */ new Map();
                for (const entry of byPage) {
                  const host = hostOf2(entry[1][0].page.normalizedUrl);
                  const bucket = bySite.get(host) ?? [];
                  bucket.push(entry);
                  bySite.set(host, bucket);
                }
                for (const host of [...bySite.keys()].sort()) {
                  const entries = bySite.get(host);
                  const notes = entries.reduce((sum, [, group]) => sum + group.length, 0);
                  const key = `site:${host}`;
                  const siteCollapsed = collapsed.has(key);
                  const section = document.createElement("div");
                  section.className = "wm-gb-site";
                  section.dataset.host = host;
                  const head = document.createElement("div");
                  head.className = "wm-gb-site-head";
                  const siteToggle = document.createElement("button");
                  siteToggle.type = "button";
                  siteToggle.className = "wm-gb-site-toggle";
                  siteToggle.setAttribute("aria-expanded", String(!siteCollapsed));
                  siteToggle.textContent = host;
                  const siteCount = document.createElement("span");
                  siteCount.className = "wm-gb-site-count";
                  siteCount.textContent = `${notes} note${notes === 1 ? "" : "s"} on ${entries.length} page${entries.length === 1 ? "" : "s"}`;
                  siteToggle.appendChild(siteCount);
                  siteToggle.addEventListener("click", () => {
                    if (siteCollapsed) collapsed.delete(key);
                    else collapsed.add(key);
                    void paint();
                  });
                  const siteExport = document.createElement("button");
                  siteExport.type = "button";
                  siteExport.className = "wm-gb-export wm-gb-site-export";
                  siteExport.textContent = "Export site";
                  siteExport.setAttribute("aria-label", `Export every annotation on ${host}`);
                  siteExport.addEventListener("click", () => {
                    exportDocument(
                      pages.filter((page) => hostOf2(page.identity.normalizedUrl) === host),
                      host
                    );
                  });
                  head.append(siteToggle, siteExport);
                  section.appendChild(head);
                  if (!siteCollapsed) {
                    for (const [pageId, group] of entries) section.appendChild(buildPageCard(pageId, group));
                  }
                  list.appendChild(section);
                }
              };
              render = () => void paint();
              let debounce = null;
              input.addEventListener("input", () => {
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => void paint(), 200);
              });
              void paint();
              return () => {
                if (debounce) clearTimeout(debounce);
                render = null;
              };
            }
          })
        );
        cleanups.push(pluginCtx.on("note:save", () => render?.()));
        cleanups.push(pluginCtx.on("note:delete", () => render?.()));
      },
      destroy() {
        for (const off of cleanups.splice(0)) off();
        render = null;
        ctx = null;
      },
      search
    };
    return plugin;
  }

  // src/plugins/chat.ts
  var MAX_PAGE_CHARS = 12e3;
  var MAX_TARGET_CHARS = 4e3;
  var MAX_SURROUNDING_CHARS = 1e3;
  var CSS4 = `
.wm-chat { display: flex; flex-direction: column; height: 100%; gap: 8px; }
.wm-chat-scope { display: flex; flex-direction: column; gap: 6px; }
.wm-chat-scope select {
  font: inherit; font-size: 12.5px; padding: 4px 6px;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328; width: 100%;
}
.wm-chat-preview { font-size: 11.5px; color: #57606a; }
.wm-chat-log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; min-height: 80px; }
.wm-chat-msg { font-size: 13px; border-radius: 8px; padding: 7px 9px; word-wrap: break-word; }
.wm-chat-user { background: #eef1f4; }
.wm-chat-assistant { background: #fff; border: 1px solid #d0d7de; }
.wm-chat-msg p:first-child, .wm-chat-msg h1, .wm-chat-msg h2, .wm-chat-msg h3 { margin-top: 0; }
.wm-chat-msg p, .wm-chat-msg ul, .wm-chat-msg ol, .wm-chat-msg pre, .wm-chat-msg blockquote { margin: 0 0 6px; }
.wm-chat-msg pre { background: #f6f8fa; padding: 6px 8px; border-radius: 6px; overflow: auto; font-size: 12px; }
.wm-chat-msg code { background: #f6f8fa; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.wm-chat-error { font-size: 12px; color: #d1242f; }
.wm-chat-input { display: flex; flex-direction: column; gap: 6px; }
.wm-chat-input textarea {
  font: inherit; font-size: 13px; padding: 6px 8px; min-height: 56px; resize: vertical;
  border: 1px solid #d0d7de; border-radius: 6px; width: 100%;
}
.wm-chat-input textarea:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
.wm-chat-row { display: flex; gap: 6px; align-items: center; }
.wm-chat-hint { flex: 1; font-size: 11px; color: #57606a; }
.wm-chat-send {
  font: inherit; font-size: 12.5px; padding: 5px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid #6366f1; background: #6366f1; color: #fff;
}
.wm-chat-send:focus-visible { outline: 2px solid #4338ca; }
.wm-chat-empty { font-size: 12.5px; color: #57606a; }
`;
  function isAsyncIterable(value) {
    return !!value && typeof value[Symbol.asyncIterator] === "function";
  }
  function createEchoProvider() {
    return {
      name: "echo",
      async send({ messages, context }) {
        const last = messages[messages.length - 1]?.content ?? "";
        const bits = [`**Echo** for _${context.page.title || context.page.normalizedUrl}_`, "", `You asked: ${last}`];
        if (context.targetText) bits.push("", `Block: ${context.targetText.slice(0, 120)}`);
        if (context.pageAnnotations) bits.push("", `Notes in context: ${context.pageAnnotations.length}`);
        if (context.pageText) bits.push("", `Page text: ${context.pageText.length} chars`);
        return { content: bits.join("\n") };
      }
    };
  }
  function createChatPlugin(options) {
    const maxPageChars = options.maxPageChars ?? MAX_PAGE_CHARS;
    let ctx = null;
    let transcript = [];
    let inFlight = null;
    const cleanups = [];
    let mounted = null;
    const requireCtx = () => {
      if (!ctx) throw new Error("chat plugin is not attached to an annotator (call annotator.use(plugin) first)");
      return ctx;
    };
    function buildContext(scope, noteId) {
      const c = requireCtx();
      const page = c.getPage();
      if (scope === "page") {
        const text = document.body?.innerText ?? "";
        return { page, pageText: text.slice(0, maxPageChars) };
      }
      if (scope === "all-notes") {
        return { page, pageAnnotations: c.getNotes().map((n) => n.annotation) };
      }
      const note = c.getNotes().find((n) => n.annotation.id === noteId) ?? c.getNotes()[0];
      if (!note) return { page };
      let targetText;
      let surroundingText;
      if (note.resolution.status === "resolved") {
        const el = note.resolution.element;
        targetText = (el.textContent || "").trim().slice(0, MAX_TARGET_CHARS);
        const around = [el.previousElementSibling, el.nextElementSibling].filter(Boolean).map((sib) => (sib.textContent || "").trim()).join(" \u2026 ");
        surroundingText = around.slice(0, MAX_SURROUNDING_CHARS) || void 0;
      } else {
        targetText = note.annotation.anchor.textQuote?.exact;
      }
      return { page, annotation: note.annotation, targetText, surroundingText };
    }
    function describeContext(context) {
      const parts = ["page title + URL"];
      if (context.pageText) parts.push(`${(context.pageText.length / 1e3).toFixed(1)}k chars of page text`);
      if (context.targetText) parts.push(`${context.targetText.length} chars of the annotated block`);
      if (context.surroundingText) parts.push("nearby text");
      if (context.annotation) parts.push("this note");
      if (context.pageAnnotations) parts.push(`${context.pageAnnotations.length} note(s)`);
      return `Will send: ${parts.join(", ")}.`;
    }
    function renderMessages() {
      if (!mounted) return;
      mounted.log.textContent = "";
      if (!transcript.length) {
        const empty = document.createElement("div");
        empty.className = "wm-chat-empty";
        empty.textContent = "Ask about this page, a note, or all notes. Nothing is sent until you press Send.";
        mounted.log.appendChild(empty);
        return;
      }
      for (const message of transcript) {
        const el = document.createElement("div");
        el.className = `wm-chat-msg wm-chat-${message.role}`;
        if (message.role === "user") el.textContent = message.content;
        else el.innerHTML = renderMarkdown(message.content);
        mounted.log.appendChild(el);
      }
      mounted.log.scrollTop = mounted.log.scrollHeight;
    }
    function refreshNoteOptions() {
      if (!mounted || !ctx) return;
      const notes = ctx.getNotes();
      const previous = mounted.noteSelect.value;
      mounted.noteSelect.textContent = "";
      for (const note of notes) {
        const option = document.createElement("option");
        option.value = note.annotation.id;
        option.textContent = note.annotation.body.text.slice(0, 40) || "(empty note)";
        mounted.noteSelect.appendChild(option);
      }
      if (previous && notes.some((n) => n.annotation.id === previous)) mounted.noteSelect.value = previous;
      mounted.noteSelect.style.display = mounted.scope.value === "note" && notes.length ? "block" : "none";
      if (mounted.scope.value === "note" && !notes.length) {
        mounted.preview.textContent = "No notes on this page yet.";
      }
    }
    function refreshPreview() {
      if (!mounted) return;
      refreshNoteOptions();
      try {
        const scope = mounted.scope.value;
        const context = buildContext(scope, mounted.noteSelect.value || void 0);
        mounted.preview.textContent = describeContext(context);
      } catch {
        mounted.preview.textContent = "";
      }
    }
    function setBusy(busy) {
      if (!mounted) return;
      mounted.send.textContent = busy ? "Stop" : "Send";
      mounted.textarea.disabled = busy;
    }
    async function ask(scope, question, noteId) {
      const text = question.trim();
      if (!text) return "";
      const context = buildContext(scope, noteId);
      transcript = [...transcript, { role: "user", content: text }];
      renderMessages();
      const controller = new AbortController();
      inFlight = controller;
      setBusy(true);
      if (mounted) mounted.error.textContent = "";
      try {
        const result = options.provider.send({ messages: transcript, context, signal: controller.signal });
        if (isAsyncIterable(result)) {
          let content = "";
          transcript = [...transcript, { role: "assistant", content }];
          let lastPaint = 0;
          for await (const chunk of result) {
            content += chunk.delta;
            transcript[transcript.length - 1] = { role: "assistant", content };
            const now = Date.now();
            if (now - lastPaint > 100) {
              lastPaint = now;
              renderMessages();
            }
          }
          renderMessages();
          return content;
        }
        const response = await result;
        transcript = [...transcript, { role: "assistant", content: response.content }];
        renderMessages();
        return response.content;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (mounted) mounted.error.textContent = message;
        throw err;
      } finally {
        if (inFlight === controller) inFlight = null;
        setBusy(false);
      }
    }
    const plugin = {
      name: "chat",
      setup(pluginCtx) {
        ctx = pluginCtx;
        cleanups.push(
          pluginCtx.addSidebarTab({
            id: "chat",
            label: "Chat",
            render(container) {
              const style = document.createElement("style");
              style.textContent = CSS4;
              container.appendChild(style);
              const root = document.createElement("div");
              root.className = "wm-chat";
              const scopeWrap = document.createElement("div");
              scopeWrap.className = "wm-chat-scope";
              const scope = document.createElement("select");
              scope.setAttribute("aria-label", "Context to send");
              for (const [value, label] of [
                ["page", "This page"],
                ["all-notes", "All notes on this page"],
                ["note", "A single note\u2026"]
              ]) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = label;
                scope.appendChild(option);
              }
              const noteSelect = document.createElement("select");
              noteSelect.setAttribute("aria-label", "Note");
              noteSelect.style.display = "none";
              const preview = document.createElement("div");
              preview.className = "wm-chat-preview";
              scopeWrap.append(scope, noteSelect, preview);
              const log = document.createElement("div");
              log.className = "wm-chat-log";
              const error = document.createElement("div");
              error.className = "wm-chat-error";
              const inputWrap = document.createElement("div");
              inputWrap.className = "wm-chat-input";
              const textarea = document.createElement("textarea");
              textarea.placeholder = "Ask a question\u2026";
              textarea.setAttribute("aria-label", "Your question");
              const row = document.createElement("div");
              row.className = "wm-chat-row";
              const hint = document.createElement("span");
              hint.className = "wm-chat-hint";
              hint.textContent = `via ${options.provider.name}`;
              const send = document.createElement("button");
              send.type = "button";
              send.className = "wm-chat-send";
              send.textContent = "Send";
              row.append(hint, send);
              inputWrap.append(textarea, row);
              root.append(scopeWrap, log, error, inputWrap);
              container.appendChild(root);
              mounted = { log, error, scope, noteSelect, preview, textarea, send };
              renderMessages();
              refreshPreview();
              const submit = () => {
                if (inFlight) {
                  inFlight.abort();
                  return;
                }
                const question = textarea.value;
                if (!question.trim()) return;
                textarea.value = "";
                void ask(scope.value, question, noteSelect.value || void 0).catch(() => {
                });
              };
              send.addEventListener("click", submit);
              textarea.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              });
              scope.addEventListener("change", refreshPreview);
              noteSelect.addEventListener("change", refreshPreview);
              return () => {
                mounted = null;
              };
            }
          })
        );
        cleanups.push(
          pluginCtx.addNoteAction({
            id: "chat-note",
            label: "Ask AI",
            onClick: (annotation) => {
              pluginCtx.activateSidebarTab("chat");
              if (mounted) {
                mounted.scope.value = "note";
                refreshNoteOptions();
                mounted.noteSelect.value = annotation.id;
                refreshPreview();
                mounted.textarea.focus();
              }
            }
          })
        );
        cleanups.push(
          pluginCtx.commands.register("chat.ask", (arg) => {
            const { scope = "page", question = "", noteId } = arg ?? {};
            return ask(scope, question, noteId);
          })
        );
        cleanups.push(pluginCtx.on("note:save", () => refreshNoteOptions()));
        cleanups.push(pluginCtx.on("note:delete", () => refreshNoteOptions()));
      },
      destroy() {
        inFlight?.abort();
        inFlight = null;
        for (const off of cleanups.splice(0)) off();
        mounted = null;
        transcript = [];
        ctx = null;
      },
      ask,
      buildContext,
      getTranscript: () => transcript.slice(),
      clearTranscript() {
        transcript = [];
        renderMessages();
      }
    };
    return plugin;
  }

  // src/providers/context-prompt.ts
  var SYSTEM_PREAMBLE = "You are helping a user understand and annotate a web page. Answer from the page context below when it is relevant, and say so plainly when it is not. Be concise: lead with the answer, then supporting detail.";
  function buildSystemPrompt(context, preamble = SYSTEM_PREAMBLE) {
    const parts = [preamble, "", "# Page", `Title: ${context.page.title ?? "(untitled)"}`, `URL: ${context.page.normalizedUrl}`];
    if (context.targetText) {
      parts.push("", "# Annotated block", "```", context.targetText, "```");
    }
    if (context.surroundingText) {
      parts.push("", "# Nearby text", "```", context.surroundingText, "```");
    }
    if (context.annotation) {
      parts.push("", "# The user's note on that block", "```", context.annotation.body.text, "```");
    }
    if (context.pageAnnotations?.length) {
      parts.push("", `# All ${context.pageAnnotations.length} note(s) on this page`);
      context.pageAnnotations.forEach((a, i) => {
        const quote = a.anchor.textQuote?.exact;
        parts.push("", `## Note ${i + 1}`);
        if (quote) parts.push(`Anchored to: ${quote.slice(0, 200)}`);
        parts.push("```", a.body.text, "```");
      });
    }
    if (context.pageText) {
      parts.push("", "# Page text", "```", context.pageText, "```");
    }
    return parts.join("\n");
  }

  // src/providers/sse.ts
  async function* parseSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              yield JSON.parse(payload);
            } catch {
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  async function describeError(response, label) {
    let detail = "";
    try {
      const text = await response.text();
      try {
        detail = JSON.parse(text)?.error?.message ?? text;
      } catch {
        detail = text;
      }
    } catch {
    }
    return `${label} ${response.status}${detail ? `: ${String(detail).slice(0, 400)}` : ""}`;
  }

  // src/providers/claude.ts
  var DEFAULT_MODEL = "claude-opus-5";
  var DEFAULT_MAX_TOKENS = 8192;
  var DEFAULT_EFFORT = "medium";
  var DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
  var API_VERSION = "2023-06-01";
  function createClaudeProvider(options) {
    const {
      apiKey,
      model = DEFAULT_MODEL,
      maxTokens = DEFAULT_MAX_TOKENS,
      effort = DEFAULT_EFFORT,
      endpoint = DEFAULT_ENDPOINT,
      fetchFn
    } = options;
    return {
      name: model,
      send(request) {
        const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
        const body = {
          model,
          max_tokens: maxTokens,
          stream: true,
          system: buildSystemPrompt(request.context),
          output_config: { effort },
          messages: request.messages.map((m) => ({ role: m.role, content: m.content }))
        };
        async function* stream() {
          const response = await doFetch(endpoint, {
            method: "POST",
            signal: request.signal,
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": API_VERSION,
              // Required for calls made straight from a browser page.
              "anthropic-dangerous-direct-browser-access": "true"
            },
            body: JSON.stringify(body)
          });
          if (!response.ok) throw new Error(await describeError(response, "Claude API"));
          if (!response.body) throw new Error("Claude API returned no response body");
          for await (const event of parseSSE(response.body)) {
            if (event.type === "error") {
              throw new Error(`Claude API error: ${event.error?.message ?? "unknown"}`);
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              yield { delta: event.delta.text };
            }
            if (event.type === "message_stop") return;
          }
        }
        return stream();
      }
    };
  }

  // src/providers/openai.ts
  var DEFAULT_MODEL2 = "gpt-5";
  var DEFAULT_BASE_URL = "https://api.openai.com/v1";
  var DEFAULT_MAX_TOKENS2 = 4096;
  function createOpenAIProvider(options) {
    const {
      apiKey,
      model = DEFAULT_MODEL2,
      baseURL = DEFAULT_BASE_URL,
      maxTokens = DEFAULT_MAX_TOKENS2,
      headers: extraHeaders,
      fetchFn
    } = options;
    const endpoint = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
    return {
      name: model,
      send(request) {
        const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
        const body = {
          model,
          stream: true,
          max_completion_tokens: maxTokens,
          messages: [
            { role: "system", content: buildSystemPrompt(request.context) },
            ...request.messages.map((m) => ({ role: m.role, content: m.content }))
          ]
        };
        async function* stream() {
          const response = await doFetch(endpoint, {
            method: "POST",
            signal: request.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
              ...extraHeaders
            },
            body: JSON.stringify(body)
          });
          if (!response.ok) throw new Error(await describeError(response, "OpenAI API"));
          if (!response.body) throw new Error("OpenAI API returned no response body");
          for await (const frame of parseSSE(response.body)) {
            if (frame.error) throw new Error(`OpenAI API error: ${frame.error.message ?? "unknown"}`);
            const delta = frame.choices?.[0]?.delta?.content;
            if (delta) yield { delta };
          }
        }
        return stream();
      }
    };
  }

  // src/plugins/excalidraw.ts
  function isExcalidrawAttachment(att) {
    return att.type === "excalidraw";
  }
  var DEFAULT_VERSIONS = { excalidraw: "0.18.0", react: "18.3.1" };
  var PREVIEW_MAX_CHARS = 8e4;
  var dynamicImport = new Function("u", "return import(u)");
  function createDefaultLoader(versions) {
    return async () => {
      const base = `https://esm.sh/@excalidraw/excalidraw@${versions.excalidraw}`;
      const g = globalThis;
      g.EXCALIDRAW_ASSET_PATH ?? (g.EXCALIDRAW_ASSET_PATH = `${base}/dist/prod/`);
      const cssHref = `${base}/dist/prod/index.css`;
      if (!document.querySelector(`link[href="${cssHref}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssHref;
        document.head.appendChild(link);
      }
      const deps = `react@${versions.react},react-dom@${versions.react}`;
      const [React, ReactDOMClient, excalidraw] = await Promise.all([
        dynamicImport(`https://esm.sh/react@${versions.react}`),
        dynamicImport(`https://esm.sh/react-dom@${versions.react}/client`),
        dynamicImport(`${base}?deps=${deps}`)
      ]);
      return { React, createRoot: ReactDOMClient.createRoot, excalidraw };
    };
  }
  function createExcalidrawPlugin(options = {}) {
    const versions = { ...DEFAULT_VERSIONS, ...options.versions };
    const loader = options.loader ?? createDefaultLoader(versions);
    const previewMaxChars = options.previewMaxChars ?? PREVIEW_MAX_CHARS;
    let ctx = null;
    let runtimePromise = null;
    let modal = null;
    let root = null;
    const cleanups = [];
    const loadRuntime = () => runtimePromise ?? (runtimePromise = loader());
    function close() {
      root?.unmount();
      root = null;
      modal?.remove();
      modal = null;
    }
    async function open(annotationId) {
      if (!ctx) throw new Error("excalidraw plugin is not attached to an annotator");
      const annotation = await ctx.annotator.getNote(annotationId);
      if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);
      const existing = (annotation.attachments ?? []).find(isExcalidrawAttachment);
      const runtime = await loadRuntime();
      close();
      const doc = document;
      modal = doc.createElement("div");
      modal.setAttribute(UI_ATTR, "");
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-label", "Whiteboard");
      modal.style.cssText = "position:fixed;inset:0;z-index:2147483200;background:rgba(15,17,20,0.55);display:flex;align-items:center;justify-content:center;";
      const panel = doc.createElement("div");
      panel.style.cssText = "width:min(1100px,94vw);height:min(720px,90vh);background:#fff;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
      const bar = doc.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #d0d7de;background:#f6f8fa;";
      const title = doc.createElement("strong");
      title.textContent = "Whiteboard";
      title.style.cssText = "font-size:13px;flex:1;";
      bar.appendChild(title);
      const mkBtn = (label, primary, onClick) => {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.cssText = `font-size:12.5px;padding:5px 14px;border-radius:6px;cursor:pointer;border:1px solid ${primary ? "#6366f1" : "#d0d7de"};background:${primary ? "#6366f1" : "#fff"};color:${primary ? "#fff" : "#1f2328"};`;
        btn.addEventListener("click", onClick);
        return btn;
      };
      const canvasHost = doc.createElement("div");
      canvasHost.style.cssText = "flex:1;min-height:0;";
      let api = null;
      const save = async () => {
        if (!api || !ctx) return;
        try {
          const elements = api.getSceneElements();
          const appState = api.getAppState();
          const files = typeof api.getFiles === "function" ? api.getFiles() : {};
          const scene = {
            elements,
            // Persist only the durable bits of appState; viewport/tool state is noise.
            appState: {
              viewBackgroundColor: appState?.viewBackgroundColor,
              gridSize: appState?.gridSize ?? null
            },
            files
          };
          let preview = existing?.preview;
          try {
            if (runtime.excalidraw.exportToSvg && elements.length) {
              const svg = await runtime.excalidraw.exportToSvg({ elements, appState: scene.appState, files });
              const markup = svg.outerHTML;
              preview = markup.length <= previewMaxChars ? markup : void 0;
            }
          } catch {
          }
          const attachment = {
            id: existing?.id ?? generateId(),
            type: "excalidraw",
            scene,
            preview
          };
          const others = (annotation.attachments ?? []).filter((a) => a.id !== attachment.id);
          await ctx.annotator.updateNote(annotation.id, { attachments: [...others, attachment] });
          close();
        } catch (err) {
          console.error("[webmods-annotate] failed to save whiteboard", err);
        }
      };
      bar.appendChild(mkBtn("Cancel", false, close));
      bar.appendChild(mkBtn("Save", true, () => void save()));
      panel.appendChild(bar);
      panel.appendChild(canvasHost);
      modal.appendChild(panel);
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      });
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
      doc.documentElement.appendChild(modal);
      const { React, createRoot } = runtime;
      root = createRoot(canvasHost);
      root.render(
        React.createElement(runtime.excalidraw.Excalidraw, {
          initialData: existing ? { elements: existing.scene.elements, files: existing.scene.files } : void 0,
          excalidrawAPI: (a) => {
            api = a;
          }
        })
      );
    }
    return {
      name: "excalidraw",
      setup(pluginCtx) {
        ctx = pluginCtx;
        cleanups.push(
          pluginCtx.addNoteAction({
            id: "excalidraw-board",
            label: (a) => (a.attachments ?? []).some(isExcalidrawAttachment) ? "Open board" : "Add board",
            onClick: (a) => void open(a.id).catch((err) => console.error("[webmods-annotate] whiteboard failed to open", err))
          })
        );
        cleanups.push(pluginCtx.commands.register("note.open-board", (id) => open(String(id))));
      },
      destroy() {
        close();
        for (const off of cleanups.splice(0)) off();
        ctx = null;
      },
      open,
      isOpen: () => !!modal,
      close
    };
  }
  return __toCommonJS(index_exports);
})();
