import { UI_ATTR } from "./blocks";
import { textSimilarity } from "./text-utils";
import type { Anchor } from "./types";

const QUOTE_MAX = 300;
const CONTEXT_CHARS = 32;

interface TextPiece {
  node: Text;
  /** Offsets of this node's data inside the block's concatenated raw text. */
  start: number;
  end: number;
}

export interface BlockTextMap {
  /** Whitespace-normalized text of the block — equals normalizeText(block.textContent). */
  text: string;
  pieces: TextPiece[];
  /** normToRaw[i] = index in the raw concatenation that normalized char i came from. */
  normToRaw: number[];
  /** rawToNorm[i] = normalized index where raw char i landed (or would land if skipped). */
  rawToNorm: number[];
}

/**
 * Build the block's normalized text together with a two-way offset map back to
 * its Text nodes. Normalization must happen over the CONCATENATION (not per node),
 * otherwise offsets drift wherever whitespace straddles a node boundary.
 */
export function blockTextWithMap(block: Element): BlockTextMap {
  const doc = block.ownerDocument;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      // Our own overlay must never contribute to the host page's text.
      if (parent?.closest(`[${UI_ATTR}]`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const pieces: TextPiece[] = [];
  let raw = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    pieces.push({ node, start: raw.length, end: raw.length + node.data.length });
    raw += node.data;
    node = walker.nextNode() as Text | null;
  }

  let text = "";
  const normToRaw: number[] = [];
  const rawToNorm: number[] = new Array(raw.length + 1);
  let lastWasSpace = false;
  for (let i = 0; i < raw.length; i++) {
    rawToNorm[i] = text.length;
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace || text.length === 0) continue; // collapse runs, drop leading
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
    if (rawToNorm[i] === undefined) rawToNorm[i] = text.length;
    else rawToNorm[i] = Math.min(rawToNorm[i], text.length);
  }

  return { text, pieces, normToRaw, rawToNorm };
}

function rawToNode(map: BlockTextMap, rawIndex: number): { node: Text; offset: number } | null {
  for (const piece of map.pieces) {
    if (rawIndex >= piece.start && rawIndex < piece.end) {
      return { node: piece.node, offset: rawIndex - piece.start };
    }
  }
  const last = map.pieces[map.pieces.length - 1];
  if (last && rawIndex >= last.end) return { node: last.node, offset: last.node.data.length };
  return null;
}

/** Turn a normalized [start,end) span back into a live DOM Range. */
export function buildRange(map: BlockTextMap, start: number, end: number): Range | null {
  if (start < 0 || end > map.text.length || end <= start) return null;
  const rawStart = map.normToRaw[start];
  const rawEnd = map.normToRaw[end - 1];
  if (rawStart === undefined || rawEnd === undefined) return null;

  const from = rawToNode(map, rawStart);
  const to = rawToNode(map, rawEnd);
  if (!from || !to) return null;

  const range = from.node.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, Math.min(to.offset + 1, to.node.data.length));
  return range;
}

/** Normalized [start,end) offsets of a live Range inside its block. */
export function rangeOffsets(range: Range, map: BlockTextMap): { start: number; end: number } | null {
  let rawStart = Infinity;
  let rawEnd = -Infinity;

  for (const piece of map.pieces) {
    let intersects: boolean;
    try {
      intersects = range.intersectsNode(piece.node);
    } catch {
      intersects = true; // conservative: let the offset math decide
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

/**
 * Build a range anchor: block-level identity (selector/xpath/fingerprint from
 * `blockAnchor`) plus the selected text, its in-block offsets and local context.
 */
export function createRangeAnchor(range: Range, block: Element, blockAnchor: Anchor): Anchor {
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
      prefix: map.text.slice(Math.max(0, offsets.start - CONTEXT_CHARS), offsets.start) || undefined,
      suffix: map.text.slice(offsets.end, offsets.end + CONTEXT_CHARS) || undefined,
    },
    textPosition: { start: offsets.start, end: offsets.start + exact.length },
    fingerprint: blockAnchor.fingerprint,
  };
}

function contextScore(map: BlockTextMap, at: number, length: number, quote: Anchor["textQuote"]): number {
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

/**
 * Locate a range anchor's text inside a (already resolved) block.
 * Returns null rather than guessing when nothing matches well enough.
 */
export function resolveRangeInBlock(block: Element, anchor: Anchor): Range | null {
  const exact = anchor.textQuote?.exact;
  if (!exact) return null;
  const map = blockTextWithMap(block);
  if (!map.text) return null;

  // 1. Stored offsets still hold the same text.
  const pos = anchor.textPosition;
  if (pos && map.text.slice(pos.start, pos.end) === exact) {
    return buildRange(map, pos.start, pos.end);
  }

  // 2. Exact substring; disambiguate repeats with prefix/suffix, then by proximity
  //    to the original offset.
  const occurrences: number[] = [];
  for (let i = map.text.indexOf(exact); i !== -1; i = map.text.indexOf(exact, i + 1)) {
    occurrences.push(i);
    if (occurrences.length > 50) break;
  }
  if (occurrences.length === 1) return buildRange(map, occurrences[0], occurrences[0] + exact.length);
  if (occurrences.length > 1) {
    let best = occurrences[0];
    let bestScore = -Infinity;
    for (const at of occurrences) {
      const score =
        contextScore(map, at, exact.length, anchor.textQuote) * 1000 -
        (pos ? Math.abs(at - pos.start) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    return buildRange(map, best, best + exact.length);
  }

  // 3. Fuzzy: slide a window the size of the quote, then refine around the best hit.
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
