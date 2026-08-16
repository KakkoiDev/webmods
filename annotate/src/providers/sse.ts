/** Shared Server-Sent Events plumbing for streaming chat providers. */

/**
 * Yield each parsed `data:` payload from an SSE body. `[DONE]` terminators and
 * frames that fail to parse are skipped — a malformed frame should not kill an
 * otherwise healthy stream.
 */
export async function* parseSSE<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; each carries one or more `data:` lines.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload) as T;
          } catch {
            // partial or malformed frame — ignore
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Turn a non-2xx response into a message that names the status and the API's own error text. */
export async function describeError(response: Response, label: string): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      detail = JSON.parse(text)?.error?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // body already consumed or unreadable
  }
  return `${label} ${response.status}${detail ? `: ${String(detail).slice(0, 400)}` : ""}`;
}
