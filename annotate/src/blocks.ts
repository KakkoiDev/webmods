import type { BlockResolver, ExcludeOption } from "./types";

const SEMANTIC_TAGS = new Set([
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
  "TH",
]);

const CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION", "LABEL", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "SVG"]);

const SKIP_CONTAINERS = new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Attribute stamped on every piece of annotator UI so it is never itself annotatable. */
export const UI_ATTR = "data-wm-annotate-ui";

export function isAnnotatorUI(el: Element): boolean {
  return !!el.closest(`[${UI_ATTR}]`) || !!(el.getRootNode() instanceof ShadowRoot && (el.getRootNode() as ShadowRoot).host?.hasAttribute(UI_ATTR));
}

export function buildExcludeFn(exclude?: ExcludeOption): (el: Element) => boolean {
  if (!exclude) return () => false;
  if (typeof exclude === "function") return exclude;
  const selectors = exclude.join(",");
  return (el) => (selectors ? !!el.closest(selectors) : false);
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.hidden) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

function ownTextLength(el: Element): number {
  return (el.textContent || "").trim().length;
}

function isInteractive(el: Element): boolean {
  if (CONTROL_TAGS.has(el.tagName)) return true;
  if (el instanceof HTMLElement && (el.isContentEditable || el.draggable)) return true;
  const role = el.getAttribute("role");
  if (role && ["button", "textbox", "slider", "checkbox", "switch", "combobox", "menuitem"].includes(role)) return true;
  return false;
}

function isNavOrOverlay(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "NAV") return true;
  const role = el.getAttribute("role");
  if (role && ["navigation", "banner", "dialog", "alert", "tooltip"].includes(role)) return true;
  return false;
}

export function scoreBlock(el: Element): number {
  let score = 0;
  const tag = el.tagName;
  const textLen = ownTextLength(el);

  if (SEMANTIC_TAGS.has(tag)) score += 30;
  else if (tag === "DIV") score += 2;
  else score += 5;

  // Content amount: reward some text, penalize giant containers that swallow the page.
  if (textLen === 0) score -= 25;
  else if (textLen < 10) score += 2;
  else if (textLen <= 800) score += 20;
  else if (textLen <= 3000) score += 8;
  else score -= 15;

  const rect = el.getBoundingClientRect();
  const area = rect.width * rect.height;
  const doc = el.ownerDocument;
  const viewportArea = (doc.defaultView?.innerWidth || 1200) * (doc.defaultView?.innerHeight || 800);
  if (area > 0 && area < viewportArea * 0.6) score += 10;
  else if (area >= viewportArea * 0.9) score -= 20;

  if (isInteractive(el)) score -= 30;
  if (isNavOrOverlay(el)) score -= 15;

  // Prefer paragraphs/list items over their section-level parents.
  if (tag === "P" || tag === "LI" || /^H[1-6]$/.test(tag) || tag === "BLOCKQUOTE" || tag === "PRE") score += 10;

  return score;
}

export function createDefaultBlockResolver(): BlockResolver {
  return (target, { exclude }) => {
    let el: Element | null = target;
    let best: Element | null = null;
    let bestScore = -Infinity;
    let depth = 0;

    while (el && depth < 12 && !SKIP_CONTAINERS.has(el.tagName)) {
      if (isAnnotatorUI(el)) return null;
      if (!exclude(el) && !CONTROL_TAGS.has(el.tagName) && isVisible(el) && ownTextLength(el) > 0) {
        const score = scoreBlock(el);
        // Strictly-greater keeps the deepest (most specific) element on ties.
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
