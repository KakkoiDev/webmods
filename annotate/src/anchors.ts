import type { Anchor, AnchorResolution, Fingerprint } from "./types";

const QUOTE_MAX = 300;
const CONTEXT_MAX = 60;
const STABLE_ATTRS = ["id", "data-testid", "data-qa", "data-test", "name", "aria-label", "role", "href", "title"];

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function blockText(el: Element): string {
  return normalizeText(el.textContent || "");
}

function looksGenerated(value: string): boolean {
  // Hashed/minified tokens (e.g. "css-1x2y3z", uuids, base64-ish blobs) make brittle selectors.
  if (/^(css|sc|jsx)-/.test(value)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(value)) return true;
  if (value.length >= 12 && !/[-_]/.test(value) && /\d/.test(value)) return true;
  return false;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Build a best-effort selector preferring ids and stable data attributes; falls back to nth-of-type path. */
export function buildSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== "HTML" && parts.length < 8) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.getAttribute("id");
    if (id && !/\d{3,}/.test(id) && !looksGenerated(id)) {
      parts.unshift(`#${cssEscape(id)}`);
      break;
    }
    const testAttr = ["data-testid", "data-qa", "data-test"].find((a) => cur!.getAttribute(a));
    if (testAttr) {
      parts.unshift(`${tag}[${testAttr}="${cur.getAttribute(testAttr)!.replace(/"/g, '\\"')}"]`);
      cur = cur.parentElement;
      continue;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : tag);
    } else {
      parts.unshift(tag);
    }
    cur = parent;
  }
  return parts.join(" > ");
}

export function buildXPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
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

function nearbyHeading(el: Element): string | undefined {
  let cur: Element | null = el;
  while (cur && cur.tagName !== "BODY") {
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) return blockText(sib).slice(0, 120) || undefined;
      const inner = sib.querySelector?.("h1,h2,h3,h4,h5,h6");
      if (inner) return blockText(inner).slice(0, 120) || undefined;
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return undefined;
}

function stableAttributes(el: Element): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  for (const name of STABLE_ATTRS) {
    const value = el.getAttribute(name);
    if (value && value.length <= 200) attrs[name] = value;
  }
  return Object.keys(attrs).length ? attrs : undefined;
}

export function createAnchor(el: Element, url: string): Anchor {
  const text = blockText(el);
  const exact = text.slice(0, QUOTE_MAX);

  let prefix: string | undefined;
  let suffix: string | undefined;
  const prev = el.previousElementSibling;
  const next = el.nextElementSibling;
  if (prev) prefix = blockText(prev).slice(-CONTEXT_MAX) || undefined;
  if (next) suffix = blockText(next).slice(0, CONTEXT_MAX) || undefined;

  return {
    url,
    selector: buildSelector(el),
    xpath: buildXPath(el),
    textQuote: exact ? { exact, prefix, suffix } : undefined,
    fingerprint: {
      tag: el.tagName.toLowerCase(),
      text: exact || undefined,
      nearbyHeading: nearbyHeading(el),
      attributes: stableAttributes(el),
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Dice coefficient over character bigrams; 0..1. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
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
  return (2 * matches) / (a.length + b.length - 2);
}

/** Fuzzy matching over more candidates than this is pointless and janky. */
const MAX_CANDIDATES = 20_000;

function candidateElements(doc: Document, tag?: string): Element[] {
  const selector = tag || "article,section,p,li,blockquote,pre,figure,table,h1,h2,h3,h4,h5,h6,dd,dt,td,th,div";
  const all = doc.querySelectorAll(selector);
  const out: Element[] = [];
  for (const el of all) {
    if ((el.textContent || "").trim().length === 0) continue;
    out.push(el);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Per-resolution memo: the same elements get scored by several strategies. */
type TextCache = WeakMap<Element, string>;

function cachedQuoteText(el: Element, cache: TextCache): string {
  let text = cache.get(el);
  if (text === undefined) {
    text = blockText(el).slice(0, QUOTE_MAX);
    cache.set(el, text);
  }
  return text;
}

function verifyAgainstQuote(el: Element, anchor: Anchor, cache: TextCache): number {
  if (!anchor.textQuote?.exact) return 0.5; // nothing to verify against; middling confidence
  return textSimilarity(cachedQuoteText(el, cache), anchor.textQuote.exact);
}

function fingerprintScore(el: Element, fp: Fingerprint, cache: TextCache): number {
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

const RESOLVE_THRESHOLD = 0.75;
const FUZZY_THRESHOLD = 0.6;

export function resolveAnchor(anchor: Anchor, doc: Document): AnchorResolution {
  const cache: TextCache = new WeakMap();

  // 1. Exact selector, verified against the stored quote so we never trust a stale path.
  if (anchor.selector) {
    try {
      const el = doc.querySelector(anchor.selector);
      if (el) {
        const confidence = verifyAgainstQuote(el, anchor, cache);
        if (confidence >= RESOLVE_THRESHOLD) return { status: "resolved", element: el, confidence };
      }
    } catch {
      // invalid selector (host DOM changed our assumptions) — fall through
    }
  }

  // 2. XPath, same verification.
  if (anchor.xpath && typeof doc.evaluate === "function") {
    try {
      const result = doc.evaluate(anchor.xpath, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
      const el = result.singleNodeValue as Element | null;
      if (el && el.nodeType === 1) {
        const confidence = verifyAgainstQuote(el, anchor, cache);
        if (confidence >= RESOLVE_THRESHOLD) return { status: "resolved", element: el, confidence };
      }
    } catch {
      // jsdom or hosts without XPath support — fall through
    }
  }

  const tag = anchor.fingerprint?.tag;

  // 3. Exact text quote among candidate blocks (prefer same tag, then any block).
  if (anchor.textQuote?.exact) {
    for (const scoped of [tag, undefined]) {
      const candidates = candidateElements(doc, scoped);
      let best: Element | null = null;
      for (const el of candidates) {
        if (cachedQuoteText(el, cache) === anchor.textQuote.exact) {
          // Prefer the deepest exact match (a <p> over the <div> containing only it).
          if (!best || best.contains(el)) best = el;
        }
      }
      if (best) return { status: "resolved", element: best, confidence: 1 };
    }
  }

  // 4/5. Structural fingerprint + heading context + fuzzy text, scored together.
  if (anchor.fingerprint) {
    const candidates = candidateElements(doc, tag);
    let best: Element | null = null;
    let bestScore = 0;
    for (const el of candidates) {
      const score = fingerprintScore(el, anchor.fingerprint, cache);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best && bestScore >= FUZZY_THRESHOLD) {
      return { status: "resolved", element: best, confidence: bestScore };
    }
  }

  // 6. Give up rather than attach to the wrong content.
  return { status: "detached", reason: "no candidate matched with sufficient confidence" };
}
