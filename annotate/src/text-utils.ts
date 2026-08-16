/** Shared text helpers, kept separate so anchor and range code don't import each other. */

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
