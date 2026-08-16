import type { AnnotatorPlugin, Attachment, PluginContext } from "../types";
import { UI_ATTR } from "../blocks";
import { generateId } from "../events";

export interface ExcalidrawScene {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface ExcalidrawAttachment extends Attachment {
  type: "excalidraw";
  scene: ExcalidrawScene;
  preview?: string;
}

export function isExcalidrawAttachment(att: Attachment): att is ExcalidrawAttachment {
  return att.type === "excalidraw";
}

/** What the lazy loader must provide: React, a root factory, and the Excalidraw module. */
export interface ExcalidrawRuntime {
  React: {
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  };
  createRoot(container: HTMLElement): { render(node: unknown): void; unmount(): void };
  excalidraw: {
    Excalidraw: unknown;
    exportToSvg?(opts: { elements: readonly unknown[]; appState?: unknown; files?: unknown }): Promise<SVGSVGElement>;
  };
}

export type ExcalidrawLoader = () => Promise<ExcalidrawRuntime>;

export interface ExcalidrawPluginOptions {
  /** Replace the CDN loader (e.g. to serve Excalidraw from your own bundle/host). */
  loader?: ExcalidrawLoader;
  /** Skip storing an SVG preview when it exceeds this many characters. */
  previewMaxChars?: number;
  /** Pin/override the CDN versions used by the default loader. */
  versions?: { excalidraw?: string; react?: string };
}

const DEFAULT_VERSIONS = { excalidraw: "0.18.0", react: "18.3.1" };
const PREVIEW_MAX_CHARS = 80_000;

// Kept out of esbuild's sight: these are runtime CDN imports, never bundled.
const dynamicImport = new Function("u", "return import(u)") as (url: string) => Promise<any>;

function createDefaultLoader(versions: { excalidraw: string; react: string }): ExcalidrawLoader {
  return async () => {
    const base = `https://esm.sh/@excalidraw/excalidraw@${versions.excalidraw}`;
    const g = globalThis as Record<string, any>;
    // Excalidraw resolves its fonts/assets relative to this global.
    g.EXCALIDRAW_ASSET_PATH ??= `${base}/dist/prod/`;

    const cssHref = `${base}/dist/prod/index.css`;
    if (!document.querySelector(`link[href="${cssHref}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cssHref;
      document.head.appendChild(link);
    }

    const deps = `react@${versions.react},react-dom@${versions.react}`;
    const [React, ReactDOMClient, excalidraw] = await Promise.all([
      dynamicImport(`https://esm.sh/react@${versions.react}`),
      dynamicImport(`https://esm.sh/react-dom@${versions.react}/client`),
      dynamicImport(`${base}?deps=${deps}`),
    ]);
    return { React, createRoot: ReactDOMClient.createRoot, excalidraw };
  };
}

export interface ExcalidrawPlugin extends AnnotatorPlugin {
  /** Open (creating if needed) the whiteboard attached to a note. */
  open(annotationId: string): Promise<void>;
  isOpen(): boolean;
  close(): void;
}

export function createExcalidrawPlugin(options: ExcalidrawPluginOptions = {}): ExcalidrawPlugin {
  const versions = { ...DEFAULT_VERSIONS, ...options.versions };
  const loader = options.loader ?? createDefaultLoader(versions);
  const previewMaxChars = options.previewMaxChars ?? PREVIEW_MAX_CHARS;

  let ctx: PluginContext | null = null;
  let runtimePromise: Promise<ExcalidrawRuntime> | null = null;
  let modal: HTMLElement | null = null;
  let root: { render(node: unknown): void; unmount(): void } | null = null;
  const cleanups: Array<() => void> = [];

  const loadRuntime = () => (runtimePromise ??= loader());

  function close(): void {
    root?.unmount();
    root = null;
    modal?.remove();
    modal = null;
  }

  async function open(annotationId: string): Promise<void> {
    if (!ctx) throw new Error("excalidraw plugin is not attached to an annotator");
    const annotation = await ctx.annotator.getNote(annotationId);
    if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);
    const existing = (annotation.attachments ?? []).find(isExcalidrawAttachment);

    const runtime = await loadRuntime();
    close();

    // Excalidraw injects global styles and measures the DOM, so the modal lives
    // in the light DOM (not our shadow root), flagged as annotator UI.
    const doc = document;
    modal = doc.createElement("div");
    modal.setAttribute(UI_ATTR, "");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Whiteboard");
    modal.style.cssText =
      "position:fixed;inset:0;z-index:2147483200;background:rgba(15,17,20,0.55);display:flex;align-items:center;justify-content:center;";

    const panel = doc.createElement("div");
    panel.style.cssText =
      "width:min(1100px,94vw);height:min(720px,90vh);background:#fff;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    const bar = doc.createElement("div");
    bar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #d0d7de;background:#f6f8fa;";
    const title = doc.createElement("strong");
    title.textContent = "Whiteboard";
    title.style.cssText = "font-size:13px;flex:1;";
    bar.appendChild(title);

    const mkBtn = (label: string, primary: boolean, onClick: () => void) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText = `font-size:12.5px;padding:5px 14px;border-radius:6px;cursor:pointer;border:1px solid ${
        primary ? "#6366f1" : "#d0d7de"
      };background:${primary ? "#6366f1" : "#fff"};color:${primary ? "#fff" : "#1f2328"};`;
      btn.addEventListener("click", onClick);
      return btn;
    };

    const canvasHost = doc.createElement("div");
    canvasHost.style.cssText = "flex:1;min-height:0;";

    let api: any = null;

    const save = async () => {
      if (!api || !ctx) return;
      try {
        const elements = api.getSceneElements();
        const appState = api.getAppState();
        const files = typeof api.getFiles === "function" ? api.getFiles() : {};
        const scene: ExcalidrawScene = {
          elements,
          // Persist only the durable bits of appState; viewport/tool state is noise.
          appState: {
            viewBackgroundColor: appState?.viewBackgroundColor,
            gridSize: appState?.gridSize ?? null,
          },
          files,
        };

        let preview: string | undefined = existing?.preview;
        try {
          if (runtime.excalidraw.exportToSvg && elements.length) {
            const svg = await runtime.excalidraw.exportToSvg({ elements, appState: scene.appState, files });
            const markup = svg.outerHTML;
            preview = markup.length <= previewMaxChars ? markup : undefined;
          }
        } catch {
          // preview is optional; never fail a save over it
        }

        const attachment: ExcalidrawAttachment = {
          id: existing?.id ?? generateId(),
          type: "excalidraw",
          scene,
          preview,
        };
        const others = (annotation.attachments ?? []).filter((a) => a.id !== attachment.id);
        await ctx.annotator.updateNote(annotation.id, { attachments: [...others, attachment] });
        close();
      } catch (err) {
        console.error("[webmods-annotate] failed to save whiteboard", err);
      }
    };

    bar.appendChild(mkBtn("Cancel", false, close));
    bar.appendChild(mkBtn("Save", true, () => void save()));
    panel.appendChild(bar);
    panel.appendChild(canvasHost);
    modal.appendChild(panel);
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    doc.documentElement.appendChild(modal);

    const { React, createRoot } = runtime;
    root = createRoot(canvasHost);
    root.render(
      React.createElement(runtime.excalidraw.Excalidraw as never, {
        initialData: existing ? { elements: existing.scene.elements, files: existing.scene.files } : undefined,
        excalidrawAPI: (a: unknown) => {
          api = a;
        },
      })
    );
  }

  return {
    name: "excalidraw",

    setup(pluginCtx) {
      ctx = pluginCtx;
      cleanups.push(
        pluginCtx.addNoteAction({
          id: "excalidraw-board",
          label: (a) => ((a.attachments ?? []).some(isExcalidrawAttachment) ? "Open board" : "Add board"),
          onClick: (a) => void open(a.id).catch((err) => console.error("[webmods-annotate] whiteboard failed to open", err)),
        })
      );
      cleanups.push(pluginCtx.commands.register("note.open-board", (id) => open(String(id))));
    },

    destroy() {
      close();
      for (const off of cleanups.splice(0)) off();
      ctx = null;
    },

    open,
    isOpen: () => !!modal,
    close,
  };
}
