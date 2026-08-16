import type { ChatChunk, ChatProvider, ChatRequest } from "../plugins/chat";
import { buildSystemPrompt } from "./context-prompt";
import { describeError, parseSSE } from "./sse";

export interface OpenAIProviderOptions {
  apiKey: string;
  /**
   * Defaults to "gpt-5". Model lineups move fast — set this explicitly to
   * whatever your account actually has.
   */
  model?: string;
  /**
   * Any OpenAI-compatible Chat Completions endpoint. Defaults to OpenAI itself.
   * Also works with OpenRouter (https://openrouter.ai/api/v1), Groq, Together,
   * and local servers such as Ollama (http://localhost:11434/v1).
   */
  baseURL?: string;
  maxTokens?: number;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  headers?: Record<string, string>;
  /** Injectable for tests, or to route through GM_xmlhttpRequest. */
  fetchFn?: typeof fetch;
}

const DEFAULT_MODEL = "gpt-5";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 4096;

interface StreamFrame {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string };
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ChatProvider {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    baseURL = DEFAULT_BASE_URL,
    maxTokens = DEFAULT_MAX_TOKENS,
    headers: extraHeaders,
    fetchFn,
  } = options;

  const endpoint = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

  return {
    name: model,

    send(request: ChatRequest): AsyncIterable<ChatChunk> {
      const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);

      // Chat Completions takes the system prompt as the first message, unlike
      // Anthropic's top-level `system` field.
      const body = {
        model,
        stream: true,
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: buildSystemPrompt(request.context) },
          ...request.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      };

      async function* stream(): AsyncGenerator<ChatChunk> {
        const response = await doFetch(endpoint, {
          method: "POST",
          signal: request.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) throw new Error(await describeError(response, "OpenAI API"));
        if (!response.body) throw new Error("OpenAI API returned no response body");

        for await (const frame of parseSSE<StreamFrame>(response.body)) {
          if (frame.error) throw new Error(`OpenAI API error: ${frame.error.message ?? "unknown"}`);
          const delta = frame.choices?.[0]?.delta?.content;
          if (delta) yield { delta };
        }
      }

      return stream();
    },
  };
}
