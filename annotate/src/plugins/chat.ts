import { renderMarkdown } from "../markdown";
import type { Annotation, AnnotatorPlugin, PageIdentity, PluginContext } from "../types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnnotationChatContext {
  page: PageIdentity;
  annotation?: Annotation;
  /** Text of the annotated block (or the stored quote when detached). */
  targetText?: string;
  /** Text immediately before/after the annotated block. */
  surroundingText?: string;
  pageAnnotations?: Annotation[];
  /** Visible page text, for the "this page" scope. */
  pageText?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  context: AnnotationChatContext;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
}

export interface ChatChunk {
  delta: string;
}

export interface ChatProvider {
  name: string;
  send(request: ChatRequest): AsyncIterable<ChatChunk> | Promise<ChatResponse>;
}

export type ChatScope = "page" | "note" | "all-notes";

export interface ChatPluginOptions {
  provider: ChatProvider;
  /** Cap on page text sent as context. */
  maxPageChars?: number;
}

export interface ChatPlugin extends AnnotatorPlugin {
  /** Programmatic ask; resolves with the assistant's full reply. */
  ask(scope: ChatScope, question: string, noteId?: string): Promise<string>;
  buildContext(scope: ChatScope, noteId?: string): AnnotationChatContext;
  getTranscript(): ChatMessage[];
  clearTranscript(): void;
}

const MAX_PAGE_CHARS = 12_000;
const MAX_TARGET_CHARS = 4_000;
const MAX_SURROUNDING_CHARS = 1_000;

const CSS = `
.wm-chat { display: flex; flex-direction: column; height: 100%; gap: 8px; }
.wm-chat-scope { display: flex; flex-direction: column; gap: 6px; }
.wm-chat-scope select {
  font: inherit; font-size: 12.5px; padding: 4px 6px;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328; width: 100%;
}
.wm-chat-preview { font-size: 11.5px; color: #57606a; }
.wm-chat-log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; min-height: 80px; }
.wm-chat-msg { font-size: 13px; border-radius: 8px; padding: 7px 9px; word-wrap: break-word; }
.wm-chat-user { background: #eef1f4; }
.wm-chat-assistant { background: #fff; border: 1px solid #d0d7de; }
.wm-chat-msg p:first-child, .wm-chat-msg h1, .wm-chat-msg h2, .wm-chat-msg h3 { margin-top: 0; }
.wm-chat-msg p, .wm-chat-msg ul, .wm-chat-msg ol, .wm-chat-msg pre, .wm-chat-msg blockquote { margin: 0 0 6px; }
.wm-chat-msg pre { background: #f6f8fa; padding: 6px 8px; border-radius: 6px; overflow: auto; font-size: 12px; }
.wm-chat-msg code { background: #f6f8fa; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.wm-chat-error { font-size: 12px; color: #d1242f; }
.wm-chat-input { display: flex; flex-direction: column; gap: 6px; }
.wm-chat-input textarea {
  font: inherit; font-size: 13px; padding: 6px 8px; min-height: 56px; resize: vertical;
  border: 1px solid #d0d7de; border-radius: 6px; width: 100%;
}
.wm-chat-input textarea:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
.wm-chat-row { display: flex; gap: 6px; align-items: center; }
.wm-chat-hint { flex: 1; font-size: 11px; color: #57606a; }
.wm-chat-send {
  font: inherit; font-size: 12.5px; padding: 5px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid #6366f1; background: #6366f1; color: #fff;
}
.wm-chat-send:focus-visible { outline: 2px solid #4338ca; }
.wm-chat-empty { font-size: 12.5px; color: #57606a; }
`;

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatChunk> {
  return !!value && typeof (value as AsyncIterable<ChatChunk>)[Symbol.asyncIterator] === "function";
}

/** Test/demo provider: echoes back what context it received. Never hits the network. */
export function createEchoProvider(): ChatProvider {
  return {
    name: "echo",
    async send({ messages, context }) {
      const last = messages[messages.length - 1]?.content ?? "";
      const bits = [`**Echo** for _${context.page.title || context.page.normalizedUrl}_`, "", `You asked: ${last}`];
      if (context.targetText) bits.push("", `Block: ${context.targetText.slice(0, 120)}`);
      if (context.pageAnnotations) bits.push("", `Notes in context: ${context.pageAnnotations.length}`);
      if (context.pageText) bits.push("", `Page text: ${context.pageText.length} chars`);
      return { content: bits.join("\n") };
    },
  };
}

export function createChatPlugin(options: ChatPluginOptions): ChatPlugin {
  const maxPageChars = options.maxPageChars ?? MAX_PAGE_CHARS;

  let ctx: PluginContext | null = null;
  let transcript: ChatMessage[] = [];
  let inFlight: AbortController | null = null;
  const cleanups: Array<() => void> = [];

  // Live view state (only while the tab is mounted).
  let mounted: {
    log: HTMLElement;
    error: HTMLElement;
    scope: HTMLSelectElement;
    noteSelect: HTMLSelectElement;
    preview: HTMLElement;
    textarea: HTMLTextAreaElement;
    send: HTMLButtonElement;
  } | null = null;

  const requireCtx = (): PluginContext => {
    if (!ctx) throw new Error("chat plugin is not attached to an annotator (call annotator.use(plugin) first)");
    return ctx;
  };

  function buildContext(scope: ChatScope, noteId?: string): AnnotationChatContext {
    const c = requireCtx();
    const page = c.getPage();

    if (scope === "page") {
      // Our UI lives in a shadow root, so it does not contribute to body.innerText.
      const text = document.body?.innerText ?? "";
      return { page, pageText: text.slice(0, maxPageChars) };
    }

    if (scope === "all-notes") {
      return { page, pageAnnotations: c.getNotes().map((n) => n.annotation) };
    }

    const note = c.getNotes().find((n) => n.annotation.id === noteId) ?? c.getNotes()[0];
    if (!note) return { page };

    let targetText: string | undefined;
    let surroundingText: string | undefined;
    if (note.resolution.status === "resolved") {
      const el = note.resolution.element;
      targetText = (el.textContent || "").trim().slice(0, MAX_TARGET_CHARS);
      const around = [el.previousElementSibling, el.nextElementSibling]
        .filter(Boolean)
        .map((sib) => (sib!.textContent || "").trim())
        .join(" … ");
      surroundingText = around.slice(0, MAX_SURROUNDING_CHARS) || undefined;
    } else {
      targetText = note.annotation.anchor.textQuote?.exact;
    }
    return { page, annotation: note.annotation, targetText, surroundingText };
  }

  function describeContext(context: AnnotationChatContext): string {
    const parts = ["page title + URL"];
    if (context.pageText) parts.push(`${(context.pageText.length / 1000).toFixed(1)}k chars of page text`);
    if (context.targetText) parts.push(`${context.targetText.length} chars of the annotated block`);
    if (context.surroundingText) parts.push("nearby text");
    if (context.annotation) parts.push("this note");
    if (context.pageAnnotations) parts.push(`${context.pageAnnotations.length} note(s)`);
    return `Will send: ${parts.join(", ")}.`;
  }

  // -- rendering ------------------------------------------------------------

  function renderMessages(): void {
    if (!mounted) return;
    mounted.log.textContent = "";
    if (!transcript.length) {
      const empty = document.createElement("div");
      empty.className = "wm-chat-empty";
      empty.textContent = "Ask about this page, a note, or all notes. Nothing is sent until you press Send.";
      mounted.log.appendChild(empty);
      return;
    }
    for (const message of transcript) {
      const el = document.createElement("div");
      el.className = `wm-chat-msg wm-chat-${message.role}`;
      if (message.role === "user") el.textContent = message.content;
      else el.innerHTML = renderMarkdown(message.content); // renderMarkdown escapes all input
      mounted.log.appendChild(el);
    }
    mounted.log.scrollTop = mounted.log.scrollHeight;
  }

  function refreshNoteOptions(): void {
    if (!mounted || !ctx) return;
    const notes = ctx.getNotes();
    const previous = mounted.noteSelect.value;
    mounted.noteSelect.textContent = "";
    for (const note of notes) {
      const option = document.createElement("option");
      option.value = note.annotation.id;
      option.textContent = note.annotation.body.text.slice(0, 40) || "(empty note)";
      mounted.noteSelect.appendChild(option);
    }
    if (previous && notes.some((n) => n.annotation.id === previous)) mounted.noteSelect.value = previous;
    mounted.noteSelect.style.display = mounted.scope.value === "note" && notes.length ? "block" : "none";
    if (mounted.scope.value === "note" && !notes.length) {
      mounted.preview.textContent = "No notes on this page yet.";
    }
  }

  function refreshPreview(): void {
    if (!mounted) return;
    refreshNoteOptions();
    try {
      const scope = mounted.scope.value as ChatScope;
      const context = buildContext(scope, mounted.noteSelect.value || undefined);
      mounted.preview.textContent = describeContext(context);
    } catch {
      mounted.preview.textContent = "";
    }
  }

  function setBusy(busy: boolean): void {
    if (!mounted) return;
    mounted.send.textContent = busy ? "Stop" : "Send";
    mounted.textarea.disabled = busy;
  }

  // -- asking ---------------------------------------------------------------

  async function ask(scope: ChatScope, question: string, noteId?: string): Promise<string> {
    const text = question.trim();
    if (!text) return "";
    const context = buildContext(scope, noteId);

    transcript = [...transcript, { role: "user", content: text }];
    renderMessages();

    const controller = new AbortController();
    inFlight = controller;
    setBusy(true);
    if (mounted) mounted.error.textContent = "";

    try {
      const result = options.provider.send({ messages: transcript, context, signal: controller.signal });

      if (isAsyncIterable(result)) {
        let content = "";
        transcript = [...transcript, { role: "assistant", content }];
        let lastPaint = 0;
        for await (const chunk of result) {
          content += chunk.delta;
          transcript[transcript.length - 1] = { role: "assistant", content };
          const now = Date.now();
          if (now - lastPaint > 100) {
            lastPaint = now;
            renderMessages();
          }
        }
        renderMessages();
        return content;
      }

      const response = await result;
      transcript = [...transcript, { role: "assistant", content: response.content }];
      renderMessages();
      return response.content;
    } catch (err) {
      // Keep the user's message so they can retry without retyping.
      const message = err instanceof Error ? err.message : String(err);
      if (mounted) mounted.error.textContent = message;
      throw err;
    } finally {
      if (inFlight === controller) inFlight = null;
      setBusy(false);
    }
  }

  const plugin: ChatPlugin = {
    name: "chat",

    setup(pluginCtx) {
      ctx = pluginCtx;

      cleanups.push(
        pluginCtx.addSidebarTab({
          id: "chat",
          label: "Chat",
          render(container) {
            const style = document.createElement("style");
            style.textContent = CSS;
            container.appendChild(style);

            const root = document.createElement("div");
            root.className = "wm-chat";

            const scopeWrap = document.createElement("div");
            scopeWrap.className = "wm-chat-scope";
            const scope = document.createElement("select");
            scope.setAttribute("aria-label", "Context to send");
            for (const [value, label] of [
              ["page", "This page"],
              ["all-notes", "All notes on this page"],
              ["note", "A single note…"],
            ] as const) {
              const option = document.createElement("option");
              option.value = value;
              option.textContent = label;
              scope.appendChild(option);
            }
            const noteSelect = document.createElement("select");
            noteSelect.setAttribute("aria-label", "Note");
            noteSelect.style.display = "none";
            const preview = document.createElement("div");
            preview.className = "wm-chat-preview";
            scopeWrap.append(scope, noteSelect, preview);

            const log = document.createElement("div");
            log.className = "wm-chat-log";

            const error = document.createElement("div");
            error.className = "wm-chat-error";

            const inputWrap = document.createElement("div");
            inputWrap.className = "wm-chat-input";
            const textarea = document.createElement("textarea");
            textarea.placeholder = "Ask a question…";
            textarea.setAttribute("aria-label", "Your question");
            const row = document.createElement("div");
            row.className = "wm-chat-row";
            const hint = document.createElement("span");
            hint.className = "wm-chat-hint";
            hint.textContent = `via ${options.provider.name}`;
            const send = document.createElement("button");
            send.type = "button";
            send.className = "wm-chat-send";
            send.textContent = "Send";
            row.append(hint, send);
            inputWrap.append(textarea, row);

            root.append(scopeWrap, log, error, inputWrap);
            container.appendChild(root);

            mounted = { log, error, scope, noteSelect, preview, textarea, send };
            renderMessages();
            refreshPreview();

            const submit = () => {
              if (inFlight) {
                inFlight.abort();
                return;
              }
              const question = textarea.value;
              if (!question.trim()) return;
              textarea.value = "";
              void ask(scope.value as ChatScope, question, noteSelect.value || undefined).catch(() => {
                /* surfaced in the error line */
              });
            };
            send.addEventListener("click", submit);
            textarea.addEventListener("keydown", (e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            });
            scope.addEventListener("change", refreshPreview);
            noteSelect.addEventListener("change", refreshPreview);

            return () => {
              mounted = null;
            };
          },
        })
      );

      cleanups.push(
        pluginCtx.addNoteAction({
          id: "chat-note",
          label: "Ask AI",
          onClick: (annotation) => {
            pluginCtx.activateSidebarTab("chat");
            if (mounted) {
              mounted.scope.value = "note";
              refreshNoteOptions();
              mounted.noteSelect.value = annotation.id;
              refreshPreview();
              mounted.textarea.focus();
            }
          },
        })
      );

      cleanups.push(
        pluginCtx.commands.register("chat.ask", (arg) => {
          const { scope = "page", question = "", noteId } = (arg ?? {}) as {
            scope?: ChatScope;
            question?: string;
            noteId?: string;
          };
          return ask(scope, question, noteId);
        })
      );

      // Keep the note picker in step with the page's notes.
      cleanups.push(pluginCtx.on("note:save", () => refreshNoteOptions()));
      cleanups.push(pluginCtx.on("note:delete", () => refreshNoteOptions()));
    },

    destroy() {
      inFlight?.abort();
      inFlight = null;
      for (const off of cleanups.splice(0)) off();
      mounted = null;
      transcript = [];
      ctx = null;
    },

    ask,
    buildContext,
    getTranscript: () => transcript.slice(),
    clearTranscript() {
      transcript = [];
      renderMessages();
    },
  };

  return plugin;
}
