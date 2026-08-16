/* @webmods/annotate v0.1.0 | MIT | https://github.com/KakkoiDev/webmods */

// src/anchors.ts
var QUOTE_MAX = 300;
var CONTEXT_MAX = 60;
var STABLE_ATTRS = ["id", "data-testid", "data-qa", "data-test", "name", "aria-label", "role", "href", "title"];
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
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
  const exact = text.slice(0, QUOTE_MAX);
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
function candidateElements(doc, tag) {
  const selector = tag || "article,section,p,li,blockquote,pre,figure,table,h1,h2,h3,h4,h5,h6,dd,dt,td,th,div";
  return Array.from(doc.querySelectorAll(selector)).filter((el) => (el.textContent || "").trim().length > 0);
}
function verifyAgainstQuote(el, anchor) {
  if (!anchor.textQuote?.exact) return 0.5;
  const text = blockText(el).slice(0, QUOTE_MAX);
  return textSimilarity(text, anchor.textQuote.exact);
}
function fingerprintScore(el, fp) {
  let score = 0;
  let weight = 0;
  if (fp.text) {
    score += textSimilarity(blockText(el).slice(0, QUOTE_MAX), fp.text) * 3;
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
function resolveAnchor(anchor, doc) {
  if (anchor.selector) {
    try {
      const el = doc.querySelector(anchor.selector);
      if (el) {
        const confidence = verifyAgainstQuote(el, anchor);
        if (confidence >= RESOLVE_THRESHOLD) return { status: "resolved", element: el, confidence };
      }
    } catch {
    }
  }
  if (anchor.xpath && typeof doc.evaluate === "function") {
    try {
      const result = doc.evaluate(anchor.xpath, doc, null, 9, null);
      const el = result.singleNodeValue;
      if (el && el.nodeType === 1) {
        const confidence = verifyAgainstQuote(el, anchor);
        if (confidence >= RESOLVE_THRESHOLD) return { status: "resolved", element: el, confidence };
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
        if (blockText(el).slice(0, QUOTE_MAX) === anchor.textQuote.exact) {
          if (!best || best.contains(el)) best = el;
        }
      }
      if (best) return { status: "resolved", element: best, confidence: 1 };
    }
  }
  if (anchor.fingerprint) {
    const candidates = candidateElements(doc, tag);
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const score = fingerprintScore(el, anchor.fingerprint);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best && bestScore >= FUZZY_THRESHOLD) {
      return { status: "resolved", element: best, confidence: bestScore };
    }
  }
  return { status: "detached", reason: "no candidate matched with sufficient confidence" };
}

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
function isInteractive(el) {
  if (CONTROL_TAGS.has(el.tagName)) return true;
  if (el instanceof HTMLElement && (el.isContentEditable || el.draggable)) return true;
  const role = el.getAttribute("role");
  if (role && ["button", "textbox", "slider", "checkbox", "switch", "combobox", "menuitem"].includes(role)) return true;
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
    return best;
  };
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
.wm-sidebar-header { display: flex; align-items: center; gap: 4px; padding: 10px 12px; border-bottom: 1px solid #d0d7de; }
.wm-tab {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border: 0; background: none; padding: 4px 8px; border-radius: 6px; color: #57606a;
}
.wm-tab[aria-selected="true"] { color: #1f2328; background: #eef1f4; }
.wm-tab:focus-visible { outline: 2px solid #6366f1; }
.wm-sidebar-body { flex: 1; overflow: auto; padding: 10px 12px; }
.wm-count { font-size: 12px; color: #57606a; margin-bottom: 8px; }
.wm-note {
  border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px;
  cursor: pointer; background: #fff;
}
.wm-note:hover { border-color: #6366f1; }
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
.wm-empty { color: #57606a; font-size: 13px; padding: 12px 4px; }
.wm-mode-pill {
  position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
  pointer-events: none; background: #1f2328; color: #fff; font-size: 12px; font-weight: 600;
  padding: 5px 14px; border-radius: 999px; opacity: 0.92; display: none;
}
`;
var AnnotatorUI = class {
  constructor(doc, options, noteCallbacks) {
    this.doc = doc;
    this.options = options;
    this.composerEl = null;
    this.markers = /* @__PURE__ */ new Map();
    this.hoverTarget = null;
    this.tabs = [{ id: "notes", label: "Notes", render: () => {
    } }];
    this.noteActions = [];
    this.activeTab = "notes";
    this.tabCleanup = null;
    this.notes = [];
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
    this.modePill.textContent = "Annotate mode \u2014 click a block to add a note (Esc to exit)";
    this.layer.appendChild(this.modePill);
    this.sidebar = doc.createElement("aside");
    this.sidebar.className = `wm-sidebar wm-${options.position}`;
    this.sidebar.setAttribute("role", "complementary");
    this.sidebar.setAttribute("aria-label", "Annotations");
    this.tabBar = doc.createElement("div");
    this.tabBar.className = "wm-sidebar-header";
    this.tabBar.setAttribute("role", "tablist");
    this.sidebar.appendChild(this.tabBar);
    this.sidebarBody = doc.createElement("div");
    this.sidebarBody.className = "wm-sidebar-body";
    this.sidebar.appendChild(this.sidebarBody);
    this.layer.appendChild(this.sidebar);
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
  destroy() {
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
  setModeIndicator(on) {
    this.modePill.style.display = on ? "block" : "none";
    if (!on) this.setHoverTarget(null);
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
  renderNotes(notes) {
    this.notes = notes;
    for (const { el } of this.markers.values()) el.remove();
    this.markers.clear();
    if (this.options.showMarkers) {
      let index = 0;
      for (const note of notes) {
        if (note.resolution.status !== "resolved") continue;
        index++;
        const marker = this.doc.createElement("button");
        marker.className = "wm-marker";
        marker.type = "button";
        marker.textContent = String(index);
        marker.setAttribute("aria-label", `Annotation ${index}: open note`);
        marker.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.noteCallbacks.onEdit(note.annotation.id);
        });
        this.layer.appendChild(marker);
        this.markers.set(note.annotation.id, { el: marker, target: note.resolution.element });
      }
      this.repositionMarkers();
    }
    if (this.activeTab === "notes") this.renderNotesTab();
  }
  scheduleReposition() {
    if (this.repositionScheduled) return;
    this.repositionScheduled = true;
    requestAnimationFrame(() => {
      this.repositionScheduled = false;
      this.repositionMarkers();
      if (this.hoverTarget) this.positionBox(this.hoverBox, this.hoverTarget);
    });
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
      composer.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          finish("cancel");
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish("save");
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
      textarea.focus();
    });
  }
  closeComposer() {
    this.composerEl?.remove();
    this.composerEl = null;
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
    this.renderTabs();
    this.activateTab(this.activeTab);
  }
  closeSidebar() {
    this.sidebar.classList.remove("wm-open");
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
    for (const tab of this.tabs) {
      const btn = this.doc.createElement("button");
      btn.className = "wm-tab";
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(tab.id === this.activeTab));
      btn.textContent = tab.label;
      btn.addEventListener("click", () => this.activateTab(tab.id));
      this.tabBar.appendChild(btn);
    }
    const spacer = this.doc.createElement("span");
    spacer.className = "wm-spacer";
    this.tabBar.appendChild(spacer);
    const close = this.makeButton("\u2715", "wm-tab", () => this.closeSidebar());
    close.setAttribute("aria-label", "Close sidebar");
    this.tabBar.appendChild(close);
  }
  activateTab(id) {
    this.activeTab = this.tabs.some((t) => t.id === id) ? id : "notes";
    this.tabCleanup?.();
    this.tabCleanup = null;
    for (const btn of this.tabBar.querySelectorAll(".wm-tab[role=tab]")) {
      const tab = this.tabs[[...this.tabBar.querySelectorAll(".wm-tab[role=tab]")].indexOf(btn)];
      btn.setAttribute("aria-selected", String(tab?.id === this.activeTab));
    }
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
    if (!this.notes.length) {
      const empty = this.doc.createElement("div");
      empty.className = "wm-empty";
      empty.textContent = "No annotations yet. Enter annotate mode and click a block to add one.";
      this.sidebarBody.appendChild(empty);
      return;
    }
    for (const note of this.notes) {
      const card = this.doc.createElement("div");
      card.className = "wm-note";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", "Go to annotation");
      const detached = note.resolution.status === "detached";
      const context = this.doc.createElement("div");
      context.className = "wm-note-context";
      context.textContent = note.annotation.anchor.textQuote?.exact?.slice(0, 90) || note.annotation.anchor.fingerprint?.tag || "";
      if (detached) {
        const badge = this.doc.createElement("span");
        badge.className = "wm-badge wm-badge-detached";
        badge.textContent = "detached";
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
      if (!detached) {
        actions.appendChild(this.makeButton("Edit", "wm-btn", () => this.noteCallbacks.onEdit(id)));
      }
      actions.appendChild(this.makeButton("Copy link", "wm-btn", () => this.noteCallbacks.onCopyLink(id)));
      for (const action of this.noteActions) {
        const label = typeof action.label === "function" ? action.label(note.annotation) : action.label;
        actions.appendChild(this.makeButton(label, "wm-btn", () => action.onClick(note.annotation)));
      }
      actions.appendChild(this.makeButton("Delete", "wm-btn wm-danger", () => this.noteCallbacks.onDelete(id)));
      card.appendChild(actions);
      const navigate = () => {
        if (!detached) this.noteCallbacks.onNavigate(id);
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
      this.sidebarBody.appendChild(card);
    }
  }
};

// src/annotator.ts
var DEFAULT_SHORTCUT = "alt+shift+a";
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
    zIndex: options.ui?.zIndex ?? 2147483e3
  };
  let mode = "explore";
  let page = resolvePageIdentity(win.location, doc);
  let resolved = [];
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
    onCopyLink: (id) => void copyNoteLink(id)
  });
  async function refresh() {
    try {
      const nextPage = resolvePageIdentity(win.location, doc);
      if (nextPage.id !== page.id) {
        page = nextPage;
        emitter.emit("page:change", { page });
      }
      const annotations = await storage.getPage(page);
      resolved = annotations.map((annotation) => {
        const resolution = resolveAnchor(annotation.anchor, doc);
        if (resolution.status === "detached") {
          emitter.emit("anchor:detached", { annotation, reason: resolution.reason });
        }
        return { annotation, resolution };
      });
      ui.renderNotes(resolved);
    } catch (err) {
      fail(err, "refresh");
    }
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
    const url = getNoteURL(id);
    try {
      const g = globalThis;
      if (typeof g.GM_setClipboard === "function") g.GM_setClipboard(url);
      else await navigator.clipboard.writeText(url);
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
  async function composeAt(target) {
    const anchor = createAnchor(target, page.url);
    const result = await ui.openComposer(target, "", false);
    if (result.action === "save" && result.text.trim()) {
      await createNote(anchor, result.text.trim());
    }
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
  let hoverEl = null;
  function onPointerMove(e) {
    if (mode !== "annotate" || ui.hasComposerOpen()) return;
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    const block = isAnnotatorUI(target) ? null : blockResolver(target, { exclude });
    if (block !== hoverEl) {
      hoverEl = block;
      ui.setHoverTarget(block);
      emitter.emit("block:hover", { element: block });
    }
  }
  function onClick(e) {
    if (mode !== "annotate" || ui.hasComposerOpen()) return;
    const target = e.target;
    if (!target || !(target instanceof Element) || isAnnotatorUI(target)) return;
    const block = hoverEl ?? blockResolver(target, { exclude });
    if (!block) return;
    e.preventDefault();
    e.stopPropagation();
    ui.setHoverTarget(null);
    void composeAt(block);
  }
  function onKeydown(e) {
    if (e.key === "Escape" && mode === "annotate" && !ui.hasComposerOpen()) {
      setMode("explore");
      return;
    }
    const shortcut = options.shortcuts?.toggle === void 0 ? DEFAULT_SHORTCUT : options.shortcuts.toggle;
    if (shortcut && matchesShortcut(e, shortcut)) {
      const target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      setMode(mode === "annotate" ? "explore" : "annotate");
    }
  }
  doc.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeydown, true);
  cleanups.push(() => {
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
      if (uiOptions.sidebar) ui.openSidebar();
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
    deleteNote,
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
function createPortableDataPlugin() {
  let ctx = null;
  const requireCtx = () => {
    if (!ctx) throw new Error("portable-data plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };
  async function collectPages() {
    const { storage, getPage } = requireCtx();
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
    const page = getPage();
    return [{ identity: page, annotations: await storage.getPage(page) }];
  }
  const plugin = {
    name: "portable-data",
    setup(pluginCtx) {
      ctx = pluginCtx;
      pluginCtx.commands.register("export.json", () => plugin.exportJSON());
      pluginCtx.commands.register("export.markdown", () => plugin.exportMarkdown());
      pluginCtx.commands.register("import.json", (data) => plugin.importJSON(data));
    },
    destroy() {
      ctx = null;
    },
    async exportJSON() {
      return {
        format: "wm-annotate-export",
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        pages: await collectPages()
      };
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
    async exportMarkdown() {
      const pages = await collectPages();
      const sections = [];
      for (const { identity, annotations } of pages) {
        if (!annotations.length) continue;
        const lines = [];
        lines.push(`# ${identity.title || identity.normalizedUrl}`);
        lines.push("");
        lines.push(`Source: ${identity.url}`);
        for (const a of [...annotations].sort((x, y) => x.createdAt - y.createdAt)) {
          lines.push("");
          const heading = a.anchor.fingerprint?.nearbyHeading || a.anchor.textQuote?.exact?.slice(0, 60) || "Note";
          lines.push(`## ${heading}`);
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
export {
  DocumentStorage,
  INLINE_FRAGMENT_PARAM,
  NOTE_FRAGMENT_PARAM,
  SCHEMA_VERSION,
  buildExcludeFn,
  buildSelector,
  buildXPath,
  createAnnotator as create,
  createAnchor,
  createAnnotator,
  createCommandRegistry,
  createDefaultBlockResolver,
  createDefaultPageIdentityResolver,
  createExcalidrawPlugin,
  createIndexedDBStorage,
  createLocalStorageStorage,
  createMemoryStorage,
  createPortableDataPlugin,
  createTampermonkeyStorage,
  emptyDB,
  generateId,
  hashString,
  createIndexedDBStorage as indexedDBStorage,
  isExcalidrawAttachment,
  createLocalStorageStorage as localStorageStorage,
  createMemoryStorage as memoryStorage,
  migrateDB,
  normalizeText,
  normalizeUrl,
  renderMarkdown,
  resolveAnchor,
  scoreBlock,
  stripOwnFragment,
  createTampermonkeyStorage as tampermonkeyStorage,
  textSimilarity,
  validateAnnotation,
  validateExportDocument
};
