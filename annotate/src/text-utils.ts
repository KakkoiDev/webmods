/** Shared text helpers, kept separate so anchor and range code don't import each other. */

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const NEVER_RENDERED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const SVG_METADATA_TAGS = new Set(["TITLE", "DESC", "METADATA"]);
const SVG_NS = "http://www.w3.org/2000/svg";

function isStyledInvisible(el: Element): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden") return true;
  // The common "sr-only" technique: clip the box to nothing rather than hide it,
  // so screen readers still see it but sighted readers never do.
  if (style.overflow === "hidden" && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1) return true;
  return false;
}

/**
 * Whether `el` or an ancestor up to and including `root` is text a reader never
 * sees: markup that is never rendered (script/style/an SVG title or desc used
 * only as a tooltip/accessible name) or text hidden purely for screen readers.
 */
export function isHiddenFromReader(el: Element, root: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (NEVER_RENDERED_TAGS.has(cur.tagName)) return true;
    if (cur.namespaceURI === SVG_NS && SVG_METADATA_TAGS.has(cur.tagName)) return true;
    if (isStyledInvisible(cur)) return true;
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return false;
}

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
