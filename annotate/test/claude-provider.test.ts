import { describe, expect, it, vi } from "vitest";
import { createClaudeProvider } from "../src/providers/claude";
import type { AnnotationChatContext, ChatChunk } from "../src/plugins/chat";

const page = { id: "pg_1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", title: "Auth docs" };

function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

const textDelta = (text: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  })}\n\n`;

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<string> {
  let out = "";
  for await (const chunk of iterable) out += chunk.delta;
  return out;
}

function ask(fetchFn: typeof fetch, context: Partial<AnnotationChatContext> = {}, options = {}) {
  const provider = createClaudeProvider({ apiKey: "sk-ant-test", fetchFn, ...options });
  return provider.send({
    messages: [{ role: "user", content: "what does this do?" }],
    context: { page, ...context },
  }) as AsyncIterable<ChatChunk>;
}

describe("claude provider request shape", () => {
  it("sends the documented browser-side headers and a streaming body", async () => {
    const fetchFn = vi.fn(async () => sseResponse([textDelta("ok")]));
    await collect(ask(fetchFn as never));

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-opus-5");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(body.output_config.effort).toBe("medium");
    expect(body.messages).toEqual([{ role: "user", content: "what does this do?" }]);
    // Sampling params are rejected by current models — never send them.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("honors model, effort, maxTokens and endpoint overrides", async () => {
    const fetchFn = vi.fn(async () => sseResponse([textDelta("ok")]));
    await collect(
      ask(fetchFn as never, {}, { model: "claude-sonnet-5", effort: "low", maxTokens: 2048, endpoint: "https://proxy.test/v1/messages" })
    );

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proxy.test/v1/messages");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.max_tokens).toBe(2048);
  });

  it("serializes the structured context into the system prompt", async () => {
    const fetchFn = vi.fn(async () => sseResponse([textDelta("ok")]));
    await collect(
      ask(fetchFn as never, {
        targetText: "Authentication is handled by the session service.",
        surroundingText: "Nearby paragraph text.",
        pageAnnotations: [
          {
            id: "a1",
            pageId: page.id,
            createdAt: 1,
            updatedAt: 1,
            anchor: { url: page.url, textQuote: { exact: "quoted block" } },
            body: { type: "markdown", text: "my note" },
          },
        ],
      })
    );

    const system = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).system;
    expect(system).toContain("Auth docs");
    expect(system).toContain("https://example.com/a");
    expect(system).toContain("Authentication is handled by the session service.");
    expect(system).toContain("Nearby paragraph text.");
    expect(system).toContain("my note");
    expect(system).toContain("quoted block");
  });

  it("forwards the abort signal to fetch", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return sseResponse([textDelta("ok")]);
    });
    const provider = createClaudeProvider({ apiKey: "k", fetchFn: fetchFn as never });
    await collect(
      provider.send({ messages: [{ role: "user", content: "hi" }], context: { page }, signal: controller.signal }) as AsyncIterable<ChatChunk>
    );
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe("claude provider SSE parsing", () => {
  it("yields text deltas in order and stops at message_stop", async () => {
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1" } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0 })}\n\n`,
      textDelta("Hello"),
      textDelta(", world"),
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      textDelta("AFTER STOP"),
    ];
    expect(await collect(ask(vi.fn(async () => sseResponse(frames)) as never))).toBe("Hello, world");
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const whole = textDelta("split me");
    const frames = [whole.slice(0, 20), whole.slice(20), `data: ${JSON.stringify({ type: "message_stop" })}\n\n`];
    expect(await collect(ask(vi.fn(async () => sseResponse(frames)) as never))).toBe("split me");
  });

  it("ignores non-text deltas and unparseable frames", async () => {
    const frames = [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hidden" },
      })}\n\n`,
      "data: {not json\n\n",
      textDelta("visible"),
    ];
    expect(await collect(ask(vi.fn(async () => sseResponse(frames)) as never))).toBe("visible");
  });

  it("throws on a mid-stream error event", async () => {
    const frames = [
      textDelta("partial"),
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
    ];
    await expect(collect(ask(vi.fn(async () => sseResponse(frames)) as never))).rejects.toThrow("Overloaded");
  });
});

describe("claude provider errors", () => {
  it("surfaces the status and API message on a non-2xx response", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
          status: 401,
        })
    );
    await expect(collect(ask(fetchFn as never))).rejects.toThrow(/401.*invalid x-api-key/);
  });

  it("reports a missing body rather than hanging", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(collect(ask(fetchFn as never))).rejects.toThrow(/no response body/);
  });

  it("does not call fetch until the stream is consumed", async () => {
    const fetchFn = vi.fn(async () => sseResponse([textDelta("ok")]));
    const stream = ask(fetchFn as never);
    expect(fetchFn).not.toHaveBeenCalled();
    await collect(stream);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
