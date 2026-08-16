import type { ChatChunk, ChatProvider, ChatRequest } from "../plugins/chat";
import { buildSystemPrompt } from "./context-prompt";
import { describeError, parseSSE } from "./sse";

export interface ClaudeProviderOptions {
  apiKey: string;
  /** Defaults to claude-opus-5. */
  model?: string;
  /** Caps thinking + response text together; keep generous — thinking is on by default. */
  maxTokens?: number;
  /** "low" | "medium" | "high" | "xhigh" | "max"; defaults to "medium" for chat latency. */
  effort?: string;
  endpoint?: string;
  /** Injectable for tests, or to route through GM_xmlhttpRequest. */
  fetchFn?: typeof fetch;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_EFFORT = "medium";
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface StreamFrame {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string; type?: string };
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

        if (!response.ok) throw new Error(await describeError(response, "Claude API"));
        if (!response.body) throw new Error("Claude API returned no response body");

        for await (const event of parseSSE<StreamFrame>(response.body)) {
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
