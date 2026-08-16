/** Small browser helpers shared by the host and plugins. */

/** Offer `text` to the user as a file download. */
export function download(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Copy text, preferring the userscript clipboard API when the host grants it. */
export async function copyText(text: string): Promise<void> {
  const g = globalThis as Record<string, any>;
  if (typeof g.GM_setClipboard === "function") {
    g.GM_setClipboard(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
