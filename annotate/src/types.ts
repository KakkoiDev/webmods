export const SCHEMA_VERSION = 1;

/** Fragment namespace used in share links: https://page#wm-note=<id> */
export const NOTE_FRAGMENT_PARAM = "wm-note";
/** Fragment namespace for inline portable payloads: https://page#wm=<data> */
export const INLINE_FRAGMENT_PARAM = "wm";

export type Mode = "explore" | "annotate";

export interface PageIdentity {
  id: string;
  url: string;
  normalizedUrl: string;
  title?: string;
}

export type PageIdentityResolver = (location: Location, document: Document) => PageIdentity;

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface Fingerprint {
  tag: string;
  text?: string;
  nearbyHeading?: string;
  attributes?: Record<string, string>;
}

export interface Anchor {
  url: string;
  /** "block" (default when absent) or "range" for a text selection inside a block. */
  kind?: "block" | "range";
  selector?: string;
  xpath?: string;
  textQuote?: TextQuote;
  /** Offsets into the block's normalized text; only meaningful for range anchors. */
  textPosition?: { start: number; end: number };
  fingerprint?: Fingerprint;
}

export type AnchorResolution =
  | {
      status: "resolved";
      element: Element;
      confidence: number;
      /**
       * Present only when a range anchor located its exact text. A range anchor
       * that found its block but not its text resolves WITHOUT a range rather
       * than highlighting the wrong words.
       */
      range?: Range;
    }
  | { status: "detached"; reason?: string };

export interface Attachment {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface Annotation {
  id: string;
  pageId: string;
  createdAt: number;
  updatedAt: number;
  anchor: Anchor;
  body: {
    type: "markdown";
    text: string;
  };
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface PageSummary {
  page: PageIdentity;
  count: number;
}

export interface AnnotationStorage {
  getPage(page: PageIdentity): Promise<Annotation[]>;
  get(id: string): Promise<Annotation | null>;
  save(annotation: Annotation, page?: PageIdentity): Promise<void>;
  delete(id: string): Promise<void>;
  listPages?(): Promise<PageSummary[]>;
  listAll?(): Promise<Annotation[]>;
  /** Host/plugin settings (API keys, preferences). Never included in exports. */
  getSetting?<T = unknown>(key: string): Promise<T | undefined>;
  setSetting?(key: string, value: unknown): Promise<void>;
}

export type BlockResolver = (target: Element, ctx: { exclude: (el: Element) => boolean }) => Element | null;

export type ExcludeOption = string[] | ((element: Element) => boolean);

export interface AnnotatorEvents {
  "mode:change": { mode: Mode };
  "block:hover": { element: Element | null };
  "note:create": { annotation: Annotation };
  "note:update": { annotation: Annotation };
  "note:save": { annotation: Annotation };
  "note:delete": { annotation: Annotation };
  "note:navigate": { annotation: Annotation };
  "anchor:detached": { annotation: Annotation; reason?: string };
  "page:change": { page: PageIdentity };
  error: { error: unknown; context?: string };
}

export type EventName = keyof AnnotatorEvents;
export type EventHandler<E extends EventName> = (payload: AnnotatorEvents[E]) => void;

export interface AnnotatorOptions {
  storage?: AnnotationStorage;
  pageIdentity?: PageIdentityResolver;
  blockResolver?: BlockResolver;

  ui?: {
    sidebar?: boolean;
    position?: "left" | "right";
    showMarkers?: boolean;
    zIndex?: number;
  };

  anchors?: {
    fuzzyMatching?: boolean;
  };

  shortcuts?: {
    /** e.g. "alt+shift+a"; null disables the built-in shortcut */
    toggle?: string | null;
    /** Toggles the notes sidebar; defaults to "alt+shift+s", null disables. */
    sidebar?: string | null;
  };

  exclude?: ExcludeOption;

  /** Query params stripped during URL normalization, in addition to the defaults. */
  stripQueryParams?: string[];

  onModeChange?(mode: Mode): void;
  onBlockHover?(element: Element | null): void;
  onCreateNote?(annotation: Annotation): void;
  onUpdateNote?(annotation: Annotation): void;
  onDeleteNote?(annotation: Annotation): void;
  onSaveNote?(annotation: Annotation): void;
  onNavigateToNote?(annotation: Annotation): void;
  onAnchorDetached?(annotation: Annotation, reason?: string): void;
  onError?(error: unknown, context?: string): void;
}

export interface ResolvedNote {
  annotation: Annotation;
  resolution: AnchorResolution;
}

export interface CommandRegistry {
  register(name: string, run: (arg?: unknown) => unknown): () => void;
  execute(name: string, arg?: unknown): unknown;
  has(name: string): boolean;
  list(): string[];
}

export interface SidebarTab {
  id: string;
  label: string;
  render(container: HTMLElement): void | (() => void);
}

/** Action button plugins can add to every note card in the sidebar. */
export interface NoteAction {
  id: string;
  label: string | ((annotation: Annotation) => string);
  onClick(annotation: Annotation): void;
}

export interface PluginContext {
  annotator: Annotator;
  storage: AnnotationStorage;
  commands: CommandRegistry;
  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void;
  addSidebarTab(tab: SidebarTab): () => void;
  addNoteAction(action: NoteAction): () => void;
  /** Open the sidebar on a specific tab (e.g. one this plugin registered). */
  activateSidebarTab(id: string): void;
  getPage(): PageIdentity;
  getNotes(): ResolvedNote[];
  scrollToNote(id: string): Promise<boolean>;
}

export interface AnnotatorPlugin {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

export interface Annotator {
  enter(): void;
  exit(): void;
  toggle(): void;
  destroy(): void;
  getMode(): Mode;

  refresh(): Promise<void>;
  getPage(): PageIdentity;
  getNotes(): ResolvedNote[];

  createNote(anchor: Anchor, body: string): Promise<Annotation>;
  updateNote(id: string, patch: Partial<Pick<Annotation, "body" | "attachments" | "metadata">>): Promise<Annotation>;
  /** Point an existing note at a new element, rebuilding its anchor. */
  reanchorNote(id: string, element: Element): Promise<Annotation>;
  deleteNote(id: string): Promise<void>;
  getNote(id: string): Promise<Annotation | null>;
  getPageNotes(page?: PageIdentity): Promise<Annotation[]>;
  scrollToNote(id: string): Promise<boolean>;
  getNoteURL(id: string): string;

  openSidebar(): void;
  closeSidebar(): void;
  toggleSidebar(): void;

  use(plugin: AnnotatorPlugin): Annotator;
  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void;

  commands: CommandRegistry;
  storage: AnnotationStorage;
}
