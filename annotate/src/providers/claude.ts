import type { AnnotationChatContext, ChatChunk, ChatProvider, ChatRequest } from "../plugins/chat";

export interface ClaudeProviderOptions {
  apiKey: string;
  /** Defaults to claude-opus-5. */
  model?: string;
  /** Caps thinking + response text together; keep generous — thinking is on by default. */
  maxTokens?: number;
  /** "low" | "medium" | "high" | "xhigh" | "max"; defaults to "medium" for chat latency. */
  effort?: string;
  endpoint?: string;
  /** Injectable for tests and for hosts that must route through GM_xmlhttpRequest. */
  fetchFn?: typeof fetch;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_EFFORT = "medium";
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const SYSTEM_PREAMBLE =
  "You are helping a user understand and annotate a web page. " +
  "Answer from the page context below when it is relevant, and say so plainly when it is not. " +
  "Be concise: lead with the answer, then supporting detail.";

/** Serialize the plugin's structured context. The provider owns this format, not the core. */
function buildSystemPrompt(context: AnnotationChatContext): string {
  const parts = [SYSTEM_PREAMBLE, "", "# Page", `Title: ${context.page.title ?? "(untitled)"}`, `URL: ${context.page.normalizedUrl}`];

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

interface SSEEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string; type?: string };
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
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
            yield JSON.parse(payload) as SSEEvent;
          } catch {
            // A partial or malformed frame is not worth failing the whole stream over.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function describeError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // body already consumed or unreadable
  }
  return `Claude API ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`;
}

export function createClaudeProvider(options: ClaudeProviderOptions): ChatProvider {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    effort = DEFAULT_EFFORT,
    endpoint = DEFAULT_ENDPOINT,
    fetchFn,
  } = options;

  return {
    name: model,

    send(request: ChatRequest): AsyncIterable<ChatChunk> {
      const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);

      const body = {
        model,
        max_tokens: maxTokens,
        stream: true,
        system: buildSystemPrompt(request.context),
        output_config: { effort },
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      };

      async function* stream(): AsyncGenerator<ChatChunk> {
        const response = await doFetch(endpoint, {
          method: "POST",
          signal: request.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": API_VERSION,
            // Required for calls made straight from a browser page.
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) throw new Error(await describeError(response));
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
    },
  };
}
