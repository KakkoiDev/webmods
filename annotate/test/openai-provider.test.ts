import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../src/providers/openai";
import type { AnnotationChatContext, ChatChunk } from "../src/plugins/chat";

const page = { id: "pg_1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", title: "Auth docs" };

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<string> {
  let out = "";
  for await (const chunk of iterable) out += chunk.delta;
  return out;
}

function ask(fetchFn: typeof fetch, context: Partial<AnnotationChatContext> = {}, options = {}) {
  const provider = createOpenAIProvider({ apiKey: "sk-test", fetchFn, ...options });
  return provider.send({
    messages: [{ role: "user", content: "what does this do?" }],
    context: { page, ...context },
  }) as AsyncIterable<ChatChunk>;
}

describe("openai provider request shape", () => {
  it("posts Chat Completions with bearer auth and streaming enabled", async () => {
    const fetchFn = vi.fn(async () => sseResponse([delta("ok")]));
    await collect(ask(fetchFn as never));

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
    // Anthropic-only headers must not leak into this provider.
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-5");
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "what does this do?" });
  });

  it("puts the annotation context in the leading system message", async () => {
    const fetchFn = vi.fn(async () => sseResponse([delta("ok")]));
    await collect(
      ask(fetchFn as never, {
        targetText: "Authentication is handled by the session service.",
        annotation: {
          id: "a1",
          pageId: page.id,
          createdAt: 1,
          updatedAt: 1,
          anchor: { url: page.url },
          body: { type: "markdown", text: "my note" },
        },
      })
    );

    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const system = body.messages[0].content;
    expect(system).toContain("Auth docs");
    expect(system).toContain("Authentication is handled by the session service.");
    expect(system).toContain("my note");
    // Unlike Anthropic, there is no top-level system field.
    expect(body.system).toBeUndefined();
  });

  it("supports OpenAI-compatible hosts via baseURL, trimming trailing slashes", async () => {
    const fetchFn = vi.fn(async () => sseResponse([delta("ok")]));
    await collect(ask(fetchFn as never, {}, { baseURL: "https://openrouter.ai/api/v1/", model: "anthropic/claude-opus-5" }));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body as string).model).toBe("anthropic/claude-opus-5");
  });

  it("merges extra headers (e.g. OpenRouter attribution)", async () => {
    const fetchFn = vi.fn(async () => sseResponse([delta("ok")]));
    await collect(ask(fetchFn as never, {}, { headers: { "HTTP-Referer": "https://webmods.local", "X-Title": "Annotate" } }));
    const headers = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://webmods.local");
    expect(headers.authorization).toBe("Bearer sk-test");
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return sseResponse([delta("ok")]);
    });
    const provider = createOpenAIProvider({ apiKey: "k", fetchFn: fetchFn as never });
    await collect(
      provider.send({ messages: [{ role: "user", content: "hi" }], context: { page }, signal: controller.signal }) as AsyncIterable<ChatChunk>
    );
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe("openai provider streaming", () => {
  it("concatenates content deltas and stops cleanly at [DONE]", async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
      delta("Hello"),
      delta(", world"),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    expect(await collect(ask(vi.fn(async () => sseResponse(frames)) as never))).toBe("Hello, world");
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const whole = delta("split me");
    const frames = [whole.slice(0, 18), whole.slice(18), "data: [DONE]\n\n"];
    expect(await collect(ask(vi.fn(async () => sseResponse(frames)) as never))).toBe("split me");
  });

  it("ignores null content and unparseable frames", async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: null } }] })}\n\n`,
      "data: {broken\n\n",
      delta("visible"),
    ];
    expect(await collect(ask(vi.fn(async () => sseResponse(frames)) as never))).toBe("visible");
  });

  it("throws on a mid-stream error frame", async () => {
    const frames = [delta("partial"), `data: ${JSON.stringify({ error: { message: "rate limit reached" } })}\n\n`];
    await expect(collect(ask(vi.fn(async () => sseResponse(frames)) as never))).rejects.toThrow("rate limit reached");
  });
});

describe("openai provider errors", () => {
  it("surfaces status and API message on non-2xx", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 })
    );
    await expect(collect(ask(fetchFn as never))).rejects.toThrow(/OpenAI API 401.*Incorrect API key/);
  });

  it("does not call fetch until the stream is consumed", async () => {
    const fetchFn = vi.fn(async () => sseResponse([delta("ok")]));
    const stream = ask(fetchFn as never);
    expect(fetchFn).not.toHaveBeenCalled();
    await collect(stream);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
