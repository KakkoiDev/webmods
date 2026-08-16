import { createAnchor, resolveAnchor } from "./anchors";
import { buildExcludeFn, createDefaultBlockResolver, isAnnotatorUI } from "./blocks";
import { createCommandRegistry } from "./commands";
import { Emitter, generateId } from "./events";
import { createDefaultPageIdentityResolver, stripOwnFragment } from "./page-identity";
import { createMemoryStorage } from "./storage";
import type {
  Anchor,
  Annotation,
  Annotator,
  AnnotatorOptions,
  AnnotatorPlugin,
  Mode,
  PageIdentity,
  PluginContext,
  ResolvedNote,
} from "./types";
import { NOTE_FRAGMENT_PARAM } from "./types";
import { AnnotatorUI } from "./ui";

const DEFAULT_SHORTCUT = "alt+shift+a";

function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return (
    e.key.toLowerCase() === key &&
    parts.includes("alt") === e.altKey &&
    parts.includes("shift") === e.shiftKey &&
    (parts.includes("ctrl") || parts.includes("control")) === e.ctrlKey &&
    (parts.includes("meta") || parts.includes("cmd")) === e.metaKey
  );
}

export function parseNoteFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of raw.split("&")) {
    const [key, value] = part.split("=");
    if (key === NOTE_FRAGMENT_PARAM && value) return decodeURIComponent(value);
  }
  return null;
}

export function createAnnotator(options: AnnotatorOptions = {}): Annotator {
  const doc = document;
  const win = window;

  const emitter = new Emitter();
  const commands = createCommandRegistry();
  const storage = options.storage ?? createMemoryStorage();
  const resolvePageIdentity = options.pageIdentity ?? createDefaultPageIdentityResolver(options.stripQueryParams);
  const exclude = buildExcludeFn(options.exclude);
  const blockResolver = options.blockResolver ?? createDefaultBlockResolver();
  const uiOptions = {
    sidebar: options.ui?.sidebar !== false,
    position: options.ui?.position ?? "right",
    showMarkers: options.ui?.showMarkers !== false,
    zIndex: options.ui?.zIndex ?? 2147483000,
  } as const;

  let mode: Mode = "explore";
  let page: PageIdentity = resolvePageIdentity(win.location, doc);
  let resolved: ResolvedNote[] = [];
  let destroyed = false;
  const plugins: AnnotatorPlugin[] = [];
  const cleanups: Array<() => void> = [];

  const fail = (error: unknown, context?: string) => {
    emitter.emit("error", { error, context });
    options.onError?.(error, context);
    console.error(`[webmods-annotate] ${context ?? "error"}`, error);
  };

  // Wire the option callbacks onto the event bus so both styles stay in sync.
  emitter.on("mode:change", ({ mode }) => options.onModeChange?.(mode));
  emitter.on("block:hover", ({ element }) => options.onBlockHover?.(element));
  emitter.on("note:create", ({ annotation }) => options.onCreateNote?.(annotation));
  emitter.on("note:update", ({ annotation }) => options.onUpdateNote?.(annotation));
  emitter.on("note:delete", ({ annotation }) => options.onDeleteNote?.(annotation));
  emitter.on("note:save", ({ annotation }) => options.onSaveNote?.(annotation));
  emitter.on("note:navigate", ({ annotation }) => options.onNavigateToNote?.(annotation));
  emitter.on("anchor:detached", ({ annotation, reason }) => options.onAnchorDetached?.(annotation, reason));

  // -- UI ---------------------------------------------------------------

  const ui = new AnnotatorUI(doc, uiOptions, {
    onNavigate: (id) => void scrollToNote(id),
    onEdit: (id) => void editNote(id),
    onDelete: (id) => void deleteNote(id),
    onCopyLink: (id) => void copyNoteLink(id),
  });

  // -- notes ------------------------------------------------------------

  async function refresh(): Promise<void> {
    try {
      const nextPage = resolvePageIdentity(win.location, doc);
      if (nextPage.id !== page.id) {
        page = nextPage;
        emitter.emit("page:change", { page });
      }
      const annotations = await storage.getPage(page);
      resolved = annotations.map((annotation) => {
        const resolution = resolveAnchor(annotation.anchor, doc);
        if (resolution.status === "detached") {
          emitter.emit("anchor:detached", { annotation, reason: resolution.reason });
        }
        return { annotation, resolution };
      });
      ui.renderNotes(resolved);
    } catch (err) {
      fail(err, "refresh");
    }
  }

  async function createNote(anchor: Anchor, body: string): Promise<Annotation> {
    const now = Date.now();
    const annotation: Annotation = {
      id: generateId(),
      pageId: page.id,
      createdAt: now,
      updatedAt: now,
      anchor,
      body: { type: "markdown", text: body },
    };
    await storage.save(annotation, page);
    emitter.emit("note:create", { annotation });
    emitter.emit("note:save", { annotation });
    await refresh();
    return annotation;
  }

  async function updateNote(
    id: string,
    patch: Partial<Pick<Annotation, "body" | "attachments" | "metadata">>
  ): Promise<Annotation> {
    const existing = await storage.get(id);
    if (!existing) throw new Error(`Annotation not found: ${id}`);
    const annotation: Annotation = { ...existing, ...patch, id, updatedAt: Date.now() };
    await storage.save(annotation);
    emitter.emit("note:update", { annotation });
    emitter.emit("note:save", { annotation });
    await refresh();
    return annotation;
  }

  async function deleteNote(id: string): Promise<void> {
    const existing = await storage.get(id);
    if (!existing) return;
    await storage.delete(id);
    emitter.emit("note:delete", { annotation: existing });
    await refresh();
  }

  async function scrollToNote(id: string): Promise<boolean> {
    const note = resolved.find((n) => n.annotation.id === id);
    if (!note) return false;
    if (note.resolution.status !== "resolved") return false;
    const el = note.resolution.element;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Flash after the smooth scroll has (mostly) settled so the box lands on the element.
    setTimeout(() => ui.flash(el), 350);
    emitter.emit("note:navigate", { annotation: note.annotation });
    return true;
  }

  function getNoteURL(id: string): string {
    const base = `${win.location.origin}${win.location.pathname}${win.location.search}`;
    const keptHash = stripOwnFragment(win.location.hash);
    const sep = keptHash ? `${keptHash}&` : "#";
    return `${base}${sep}${NOTE_FRAGMENT_PARAM}=${encodeURIComponent(id)}`;
  }

  async function copyNoteLink(id: string): Promise<void> {
    const url = getNoteURL(id);
    try {
      const g = globalThis as Record<string, any>;
      if (typeof g.GM_setClipboard === "function") g.GM_setClipboard(url);
      else await navigator.clipboard.writeText(url);
    } catch (err) {
      fail(err, "copy-link");
    }
  }

  async function editNote(id: string): Promise<void> {
    const note = resolved.find((n) => n.annotation.id === id);
    if (!note) return;
    const target = note.resolution.status === "resolved" ? note.resolution.element : doc.body;
    const result = await ui.openComposer(target, note.annotation.body.text, true);
    if (result.action === "save") {
      const text = result.text.trim();
      if (text) await updateNote(id, { body: { type: "markdown", text } });
      else await deleteNote(id);
    } else if (result.action === "delete") {
      await deleteNote(id);
    }
  }

  async function composeAt(target: Element): Promise<void> {
    const anchor = createAnchor(target, page.url);
    const result = await ui.openComposer(target, "", false);
    if (result.action === "save" && result.text.trim()) {
      await createNote(anchor, result.text.trim());
    }
  }

  // -- modes --------------------------------------------------------------

  function setMode(next: Mode): void {
    if (mode === next || destroyed) return;
    mode = next;
    ui.setModeIndicator(next === "annotate");
    if (next === "explore") {
      ui.closeComposer();
      emitter.emit("block:hover", { element: null });
    }
    emitter.emit("mode:change", { mode: next });
  }

  let hoverEl: Element | null = null;

  function onPointerMove(e: PointerEvent): void {
    if (mode !== "annotate" || ui.hasComposerOpen()) return;
    const target = e.target as Element | null;
    if (!target || !(target instanceof Element)) return;
    const block = isAnnotatorUI(target) ? null : blockResolver(target, { exclude });
    if (block !== hoverEl) {
      hoverEl = block;
      ui.setHoverTarget(block);
      emitter.emit("block:hover", { element: block });
    }
  }

  function onClick(e: MouseEvent): void {
    if (mode !== "annotate" || ui.hasComposerOpen()) return;
    const target = e.target as Element | null;
    if (!target || !(target instanceof Element) || isAnnotatorUI(target)) return;
    const block = hoverEl ?? blockResolver(target, { exclude });
    if (!block) return;
    e.preventDefault();
    e.stopPropagation();
    ui.setHoverTarget(null);
    void composeAt(block);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && mode === "annotate" && !ui.hasComposerOpen()) {
      setMode("explore");
      return;
    }
    const shortcut = options.shortcuts?.toggle === undefined ? DEFAULT_SHORTCUT : options.shortcuts.toggle;
    if (shortcut && matchesShortcut(e, shortcut)) {
      const target = e.target as Element | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLElement).isContentEditable)) return;
      e.preventDefault();
      setMode(mode === "annotate" ? "explore" : "annotate");
    }
  }

  doc.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeydown, true);
  cleanups.push(() => {
    doc.removeEventListener("pointermove", onPointerMove, { capture: true } as EventListenerOptions);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKeydown, true);
  });

  // -- navigation / SPA ------------------------------------------------------

  async function handleNoteFragment(): Promise<void> {
    const noteId = parseNoteFragment(win.location.hash);
    if (!noteId) return;
    try {
      const annotation = await storage.get(noteId);
      if (!annotation) return;
      await refresh();
      if (uiOptions.sidebar) ui.openSidebar();
      await scrollToNote(noteId);
    } catch (err) {
      fail(err, "note-fragment");
    }
  }

  const onHashChange = () => void handleNoteFragment();
  const onPopState = () => void refresh();
  win.addEventListener("hashchange", onHashChange);
  win.addEventListener("popstate", onPopState);
  cleanups.push(() => {
    win.removeEventListener("hashchange", onHashChange);
    win.removeEventListener("popstate", onPopState);
  });

  // Detect History API pushState/replaceState navigation (SPAs).
  const history = win.history;
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    origPush(...args);
    void refresh();
  };
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    origReplace(...args);
    void refresh();
  };
  cleanups.push(() => {
    history.pushState = origPush;
    history.replaceState = origReplace;
  });

  // -- plugins --------------------------------------------------------------

  function makePluginContext(): PluginContext {
    return {
      annotator: api,
      storage,
      commands,
      on: (event, handler) => emitter.on(event, handler),
      addSidebarTab: (tab) => ui.addTab(tab),
      addNoteAction: (action) => ui.addNoteAction(action),
      getPage: () => page,
      getNotes: () => resolved.slice(),
      scrollToNote,
    };
  }

  // -- commands ---------------------------------------------------------------

  commands.register("annotate.enter", () => setMode("annotate"));
  commands.register("annotate.exit", () => setMode("explore"));
  commands.register("annotate.toggle", () => setMode(mode === "annotate" ? "explore" : "annotate"));
  commands.register("sidebar.toggle", () => (ui.isSidebarOpen() ? ui.closeSidebar() : ui.openSidebar()));
  commands.register("note.delete", (id) => deleteNote(String(id)));
  commands.register("note.scroll-to", (id) => scrollToNote(String(id)));
  commands.register("note.copy-link", (id) => copyNoteLink(String(id)));
  commands.register("note.edit", (id) => editNote(String(id)));

  // -- public API -------------------------------------------------------------

  const api: Annotator = {
    enter: () => setMode("annotate"),
    exit: () => setMode("explore"),
    toggle: () => setMode(mode === "annotate" ? "explore" : "annotate"),
    getMode: () => mode,

    refresh,
    getPage: () => page,
    getNotes: () => resolved.slice(),

    createNote,
    updateNote,
    deleteNote,
    getNote: (id) => storage.get(id),
    getPageNotes: (p) => storage.getPage(p ?? page),
    scrollToNote,
    getNoteURL,

    openSidebar: () => ui.openSidebar(),
    closeSidebar: () => ui.closeSidebar(),
    toggleSidebar: () => (ui.isSidebarOpen() ? ui.closeSidebar() : ui.openSidebar()),

    use(plugin: AnnotatorPlugin) {
      plugins.push(plugin);
      Promise.resolve(plugin.setup(makePluginContext())).catch((err) => fail(err, `plugin:${plugin.name}`));
      return api;
    },

    on: (event, handler) => emitter.on(event, handler),

    commands,
    storage,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      setMode("explore");
      for (const plugin of plugins) {
        Promise.resolve(plugin.destroy?.()).catch((err) => fail(err, `plugin-destroy:${plugin.name}`));
      }
      for (const off of cleanups) off();
      ui.destroy();
      emitter.clear();
    },
  };

  // Initial load: resolve stored notes, then honor an incoming #wm-note= link.
  void refresh().then(handleNoteFragment);

  return api;
}
