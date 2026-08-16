import { UI_ATTR } from "./blocks";
import { renderMarkdown } from "./markdown";
import type { NoteAction, ResolvedNote, SidebarTab } from "./types";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wm-layer {
  position: fixed; inset: 0; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.45; color: #1f2328;
}
.wm-hover {
  position: fixed; pointer-events: none; display: none;
  border: 2px solid #6366f1; border-radius: 4px;
  background: rgba(99, 102, 241, 0.08);
  transition: top 60ms linear, left 60ms linear, width 60ms linear, height 60ms linear;
}
.wm-flash {
  position: fixed; pointer-events: none;
  border: 2px solid #f59e0b; border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  animation: wm-fade 2.2s ease-out forwards;
}
@keyframes wm-fade { 0%, 55% { opacity: 1; } 100% { opacity: 0; } }
.wm-marker {
  position: fixed; pointer-events: auto; cursor: pointer;
  width: 22px; height: 22px; border-radius: 50%;
  background: #6366f1; color: #fff; border: 2px solid #fff;
  font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 4px rgba(0,0,0,0.35);
}
.wm-marker:hover, .wm-marker:focus-visible { background: #4338ca; outline: 2px solid #c7d2fe; }
.wm-marker.wm-detached { background: #9ca3af; }
.wm-composer {
  position: fixed; pointer-events: auto; z-index: 2;
  width: 320px; max-width: calc(100vw - 24px);
  background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18); padding: 10px;
}
.wm-composer textarea {
  width: 100%; min-height: 90px; resize: vertical;
  font: inherit; font-size: 13px; padding: 6px 8px;
  border: 1px solid #d0d7de; border-radius: 6px;
}
.wm-composer textarea:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
.wm-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.wm-spacer { flex: 1; }
button.wm-btn {
  font: inherit; font-size: 12.5px; cursor: pointer;
  padding: 5px 12px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328;
}
button.wm-btn:hover { background: #eef1f4; }
button.wm-btn:focus-visible { outline: 2px solid #6366f1; }
button.wm-btn.wm-primary { background: #6366f1; border-color: #6366f1; color: #fff; }
button.wm-btn.wm-primary:hover { background: #4f46e5; }
button.wm-btn.wm-danger { color: #d1242f; }
.wm-sidebar {
  position: fixed; top: 0; bottom: 0; width: 340px; max-width: 92vw;
  pointer-events: auto; display: none; flex-direction: column;
  background: #fff; border-left: 1px solid #d0d7de;
  box-shadow: -4px 0 16px rgba(0,0,0,0.12);
}
.wm-sidebar.wm-left { left: 0; right: auto; border-left: 0; border-right: 1px solid #d0d7de; box-shadow: 4px 0 16px rgba(0,0,0,0.12); }
.wm-sidebar.wm-right { right: 0; }
.wm-sidebar.wm-open { display: flex; }
.wm-sidebar-header { display: flex; align-items: center; gap: 4px; padding: 10px 12px; border-bottom: 1px solid #d0d7de; }
.wm-tab {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border: 0; background: none; padding: 4px 8px; border-radius: 6px; color: #57606a;
}
.wm-tab[aria-selected="true"] { color: #1f2328; background: #eef1f4; }
.wm-tab:focus-visible { outline: 2px solid #6366f1; }
.wm-sidebar-body { flex: 1; overflow: auto; padding: 10px 12px; }
.wm-count { font-size: 12px; color: #57606a; margin-bottom: 8px; }
.wm-note {
  border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px;
  cursor: pointer; background: #fff;
}
.wm-note:hover { border-color: #6366f1; }
.wm-note-focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3); transition: box-shadow 300ms; }
.wm-note:focus-visible { outline: 2px solid #6366f1; }
.wm-note-context {
  font-size: 11.5px; color: #57606a; border-left: 3px solid #d0d7de; padding-left: 6px;
  margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wm-note-body { font-size: 13px; word-wrap: break-word; }
.wm-note-body p, .wm-note-body h1, .wm-note-body h2, .wm-note-body h3, .wm-note-body h4, .wm-note-body h5, .wm-note-body h6,
.wm-note-body ul, .wm-note-body ol, .wm-note-body blockquote, .wm-note-body pre { margin: 0 0 6px; }
.wm-note-body h1 { font-size: 16px; } .wm-note-body h2 { font-size: 15px; } .wm-note-body h3 { font-size: 14px; }
.wm-note-body pre { background: #f6f8fa; padding: 6px 8px; border-radius: 6px; overflow: auto; font-size: 12px; }
.wm-note-body code { background: #f6f8fa; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.wm-note-body blockquote { color: #57606a; border-left: 3px solid #d0d7de; padding-left: 8px; }
.wm-note-body a { color: #4f46e5; }
.wm-note-actions { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.wm-note-preview {
  display: block; max-width: 100%; max-height: 140px; margin-top: 6px;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff;
}
.wm-note-actions button { font-size: 11.5px; padding: 3px 8px; }
.wm-badge {
  display: inline-block; font-size: 10.5px; font-weight: 600; border-radius: 999px; padding: 1px 7px; margin-left: 6px;
}
.wm-badge-detached { background: #fff1f0; color: #d1242f; border: 1px solid #ffd7d5; }
.wm-badge-attach { background: #eef1f4; color: #57606a; border: 1px solid #d0d7de; }
.wm-empty { color: #57606a; font-size: 13px; padding: 12px 4px; }
.wm-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wm-mode-pill {
  position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
  pointer-events: none; background: #1f2328; color: #fff; font-size: 12px; font-weight: 600;
  padding: 5px 14px; border-radius: 999px; opacity: 0.92; display: none;
}
`;

export interface ComposerResult {
  action: "save" | "cancel" | "delete";
  text: string;
}

export interface UIOptions {
  position: "left" | "right";
  zIndex: number;
  showMarkers: boolean;
}

interface NoteCallbacks {
  onNavigate(id: string): void;
  onEdit(id: string): void;
  onDelete(id: string): void;
  onCopyLink(id: string): void;
  onReattach(id: string): void;
}

const MODE_TEXT_DEFAULT = "Annotate mode — click a block to add a note (Esc to exit)";

export class AnnotatorUI {
  private host: HTMLElement;
  private root: ShadowRoot;
  private layer: HTMLElement;
  private hoverBox: HTMLElement;
  private sidebar: HTMLElement;
  private sidebarBody: HTMLElement;
  private tabBar: HTMLElement;
  private modePill: HTMLElement;
  private liveRegion: HTMLElement;
  private composerEl: HTMLElement | null = null;
  private composerReturnFocus: HTMLElement | null = null;
  private markers = new Map<string, { el: HTMLElement; target: Element }>();
  private hoverTarget: Element | null = null;
  private tabs: SidebarTab[] = [{ id: "notes", label: "Notes", render: () => {} }];
  private noteActions: NoteAction[] = [];
  private activeTab = "notes";
  private tabCleanup: (() => void) | null = null;
  private notes: ResolvedNote[] = [];
  private noteCallbacks: NoteCallbacks;
  private repositionScheduled = false;
  private listeners: Array<() => void> = [];

  constructor(private doc: Document, private options: UIOptions, noteCallbacks: NoteCallbacks) {
    this.noteCallbacks = noteCallbacks;
    this.host = doc.createElement("div");
    this.host.setAttribute(UI_ATTR, "");
    this.host.style.cssText = `position: fixed; inset: 0; pointer-events: none; z-index: ${options.zIndex};`;
    this.root = this.host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = CSS;
    this.root.appendChild(style);

    this.layer = doc.createElement("div");
    this.layer.className = "wm-layer";
    this.root.appendChild(this.layer);

    this.hoverBox = doc.createElement("div");
    this.hoverBox.className = "wm-hover";
    this.layer.appendChild(this.hoverBox);

    this.modePill = doc.createElement("div");
    this.modePill.className = "wm-mode-pill";
    this.modePill.textContent = MODE_TEXT_DEFAULT;
    this.layer.appendChild(this.modePill);

    // Screen-reader announcements for state that is otherwise only visual.
    this.liveRegion = doc.createElement("div");
    this.liveRegion.className = "wm-sr-only";
    this.liveRegion.setAttribute("aria-live", "polite");
    this.liveRegion.setAttribute("role", "status");
    this.layer.appendChild(this.liveRegion);

    this.sidebar = doc.createElement("aside");
    this.sidebar.className = `wm-sidebar wm-${options.position}`;
    this.sidebar.setAttribute("role", "complementary");
    this.sidebar.setAttribute("aria-label", "Annotations");
    this.tabBar = doc.createElement("div");
    this.tabBar.className = "wm-sidebar-header";
    this.tabBar.setAttribute("role", "tablist");
    this.sidebar.appendChild(this.tabBar);
    this.sidebarBody = doc.createElement("div");
    this.sidebarBody.className = "wm-sidebar-body";
    this.sidebar.appendChild(this.sidebarBody);
    this.layer.appendChild(this.sidebar);

    doc.documentElement.appendChild(this.host);

    const reposition = () => this.scheduleReposition();
    doc.addEventListener("scroll", reposition, { capture: true, passive: true });
    this.listeners.push(() => doc.removeEventListener("scroll", reposition, { capture: true } as EventListenerOptions));
    const win = doc.defaultView;
    if (win) {
      win.addEventListener("resize", reposition, { passive: true });
      this.listeners.push(() => win.removeEventListener("resize", reposition));
    }
  }

  destroy(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.tabCleanup?.();
    this.host.remove();
  }

  // -- hover highlight ------------------------------------------------------

  setHoverTarget(el: Element | null): void {
    this.hoverTarget = el;
    if (!el) {
      this.hoverBox.style.display = "none";
      return;
    }
    this.positionBox(this.hoverBox, el);
    this.hoverBox.style.display = "block";
  }

  setModeIndicator(on: boolean, text?: string): void {
    this.modePill.textContent = text ?? MODE_TEXT_DEFAULT;
    this.modePill.style.display = on ? "block" : "none";
    this.announce(on ? text ?? "Annotation mode on" : "Annotation mode off");
    if (!on) this.setHoverTarget(null);
  }

  /** Announce a transient message to assistive tech. */
  announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  private positionBox(box: HTMLElement, target: Element): void {
    const rect = target.getBoundingClientRect();
    box.style.top = `${rect.top - 2}px`;
    box.style.left = `${rect.left - 2}px`;
    box.style.width = `${rect.width + 4}px`;
    box.style.height = `${rect.height + 4}px`;
  }

  flash(target: Element): void {
    const flash = this.doc.createElement("div");
    flash.className = "wm-flash";
    this.positionBox(flash, target);
    this.layer.appendChild(flash);
    setTimeout(() => flash.remove(), 2300);
  }

  // -- markers --------------------------------------------------------------

  renderNotes(notes: ResolvedNote[]): void {
    this.notes = notes;
    for (const { el } of this.markers.values()) el.remove();
    this.markers.clear();

    if (this.options.showMarkers) {
      let index = 0;
      for (const note of notes) {
        if (note.resolution.status !== "resolved") continue;
        index++;
        const marker = this.doc.createElement("button");
        marker.className = "wm-marker";
        marker.type = "button";
        marker.textContent = String(index);
        marker.setAttribute("aria-label", `Annotation ${index}: show note in sidebar`);
        marker.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.focusNote(note.annotation.id);
        });
        this.layer.appendChild(marker);
        this.markers.set(note.annotation.id, { el: marker, target: note.resolution.element });
      }
      this.repositionMarkers();
    }

    if (this.activeTab === "notes") this.renderNotesTab();
  }

  private scheduleReposition(): void {
    if (this.repositionScheduled) return;
    this.repositionScheduled = true;
    requestAnimationFrame(() => {
      this.repositionScheduled = false;
      this.repositionMarkers();
      if (this.hoverTarget) this.positionBox(this.hoverBox, this.hoverTarget);
    });
  }

  private repositionMarkers(): void {
    const win = this.doc.defaultView;
    const vh = win?.innerHeight ?? 800;
    for (const { el, target } of this.markers.values()) {
      const rect = target.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < vh;
      el.style.display = visible ? "flex" : "none";
      if (visible) {
        // Left gutter, comment-style; blocks often extend under the overlaid
        // sidebar, so anchoring to rect.right would land markers on top of it.
        el.style.top = `${rect.top}px`;
        el.style.left = `${Math.max(4, rect.left - 30)}px`;
      }
    }
  }

  // -- composer -------------------------------------------------------------

  openComposer(target: Element, initialText: string, canDelete: boolean): Promise<ComposerResult> {
    this.closeComposer();
    return new Promise((resolve) => {
      const composer = this.doc.createElement("div");
      composer.className = "wm-composer";
      composer.setAttribute("role", "dialog");
      composer.setAttribute("aria-label", canDelete ? "Edit annotation" : "New annotation");

      const textarea = this.doc.createElement("textarea");
      textarea.value = initialText;
      textarea.placeholder = "Write a note (Markdown supported)…";
      textarea.setAttribute("aria-label", "Note text");
      composer.appendChild(textarea);

      const row = this.doc.createElement("div");
      row.className = "wm-row";
      const finish = (action: ComposerResult["action"]) => {
        this.closeComposer();
        resolve({ action, text: textarea.value });
      };
      if (canDelete) {
        const del = this.makeButton("Delete", "wm-btn wm-danger", () => finish("delete"));
        del.setAttribute("aria-label", "Delete note");
        row.appendChild(del);
      }
      const spacer = this.doc.createElement("span");
      spacer.className = "wm-spacer";
      row.appendChild(spacer);
      row.appendChild(this.makeButton("Cancel", "wm-btn", () => finish("cancel")));
      const save = this.makeButton("Save", "wm-btn wm-primary", () => finish("save"));
      row.appendChild(save);
      composer.appendChild(row);

      composer.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          finish("cancel");
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish("save");
        } else if (e.key === "Tab") {
          // Trap focus inside the dialog: the host page's tab order is irrelevant here.
          const focusables = [...composer.querySelectorAll<HTMLElement>("textarea, button")];
          if (!focusables.length) return;
          const active = this.root.activeElement as HTMLElement | null;
          const index = active ? focusables.indexOf(active) : -1;
          const next = e.shiftKey
            ? focusables[(index <= 0 ? focusables.length : index) - 1]
            : focusables[(index + 1) % focusables.length];
          e.preventDefault();
          next?.focus();
        }
      });

      const rect = target.getBoundingClientRect();
      const win = this.doc.defaultView;
      const vw = win?.innerWidth ?? 1200;
      const vh = win?.innerHeight ?? 800;
      const top = Math.min(Math.max(rect.top, 12), vh - 200);
      const left = Math.min(Math.max(rect.right + 10, 12), vw - 340);
      composer.style.top = `${top}px`;
      composer.style.left = `${left}px`;

      this.layer.appendChild(composer);
      this.composerEl = composer;
      this.composerReturnFocus = this.doc.activeElement as HTMLElement | null;
      textarea.focus();
    });
  }

  closeComposer(): void {
    this.composerEl?.remove();
    this.composerEl = null;
    // Hand focus back where it came from, if that element is still around.
    const back = this.composerReturnFocus;
    this.composerReturnFocus = null;
    if (back && back.isConnected) back.focus?.();
  }

  hasComposerOpen(): boolean {
    return !!this.composerEl;
  }

  private makeButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // -- sidebar --------------------------------------------------------------

  isSidebarOpen(): boolean {
    return this.sidebar.classList.contains("wm-open");
  }

  openSidebar(): void {
    this.sidebar.classList.add("wm-open");
    this.renderTabs();
    this.activateTab(this.activeTab);
  }

  closeSidebar(): void {
    this.sidebar.classList.remove("wm-open");
  }

  /** Open the sidebar on the Notes tab with one note's card scrolled into view and emphasized. */
  focusNote(id: string): void {
    this.activeTab = "notes";
    this.openSidebar();
    const card = this.sidebarBody.querySelector(`.wm-note[data-note-id="${id}"]`);
    if (!(card instanceof HTMLElement)) return;
    card.scrollIntoView?.({ block: "nearest" });
    card.classList.add("wm-note-focus");
    card.focus?.({ preventScroll: true });
    setTimeout(() => card.classList.remove("wm-note-focus"), 1800);
  }

  addNoteAction(action: NoteAction): () => void {
    this.noteActions.push(action);
    this.renderNotesTab();
    return () => {
      this.noteActions = this.noteActions.filter((a) => a !== action);
      this.renderNotesTab();
    };
  }

  addTab(tab: SidebarTab): () => void {
    this.tabs.push(tab);
    if (this.isSidebarOpen()) this.renderTabs();
    return () => {
      this.tabs = this.tabs.filter((t) => t !== tab);
      if (this.activeTab === tab.id) this.activateTab("notes");
      if (this.isSidebarOpen()) this.renderTabs();
    };
  }

  private renderTabs(): void {
    this.tabBar.textContent = "";
    this.tabs.forEach((tab, index) => {
      const btn = this.doc.createElement("button");
      btn.className = "wm-tab";
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.dataset.tabId = tab.id;
      btn.setAttribute("aria-selected", String(tab.id === this.activeTab));
      // Roving tabindex: only the selected tab is in the page tab order.
      btn.tabIndex = tab.id === this.activeTab ? 0 : -1;
      btn.textContent = tab.label;
      btn.addEventListener("click", () => this.activateTab(tab.id));
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        const last = this.tabs.length - 1;
        const next =
          e.key === "Home" ? 0
          : e.key === "End" ? last
          : e.key === "ArrowRight" ? (index + 1) % this.tabs.length
          : (index - 1 + this.tabs.length) % this.tabs.length;
        this.activateTab(this.tabs[next].id);
        this.tabBar.querySelector<HTMLElement>(`.wm-tab[data-tab-id="${this.tabs[next].id}"]`)?.focus();
      });
      this.tabBar.appendChild(btn);
    });
    const spacer = this.doc.createElement("span");
    spacer.className = "wm-spacer";
    this.tabBar.appendChild(spacer);
    const close = this.makeButton("✕", "wm-tab", () => this.closeSidebar());
    close.setAttribute("aria-label", "Close sidebar");
    this.tabBar.appendChild(close);
  }

  /** Switch the sidebar to a tab by id (falls back to Notes for unknown ids). */
  activateTab(id: string): void {
    this.activeTab = this.tabs.some((t) => t.id === id) ? id : "notes";
    this.tabCleanup?.();
    this.tabCleanup = null;
    for (const btn of this.tabBar.querySelectorAll<HTMLElement>(".wm-tab[role=tab]")) {
      const selected = btn.dataset.tabId === this.activeTab;
      btn.setAttribute("aria-selected", String(selected));
      btn.tabIndex = selected ? 0 : -1;
    }
    this.sidebarBody.textContent = "";
    if (this.activeTab === "notes") {
      this.renderNotesTab();
    } else {
      const tab = this.tabs.find((t) => t.id === this.activeTab);
      const cleanup = tab?.render(this.sidebarBody);
      if (typeof cleanup === "function") this.tabCleanup = cleanup;
    }
  }

  private renderNotesTab(): void {
    if (this.activeTab !== "notes" || !this.isSidebarOpen()) return;
    this.sidebarBody.textContent = "";

    const count = this.doc.createElement("div");
    count.className = "wm-count";
    count.textContent = `${this.notes.length} note${this.notes.length === 1 ? "" : "s"} on this page`;
    this.sidebarBody.appendChild(count);

    if (!this.notes.length) {
      const empty = this.doc.createElement("div");
      empty.className = "wm-empty";
      empty.textContent = "No annotations yet. Enter annotate mode and click a block to add one.";
      this.sidebarBody.appendChild(empty);
      return;
    }

    for (const note of this.notes) {
      const card = this.doc.createElement("div");
      card.className = "wm-note";
      card.dataset.noteId = note.annotation.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", "Go to annotation");

      const detached = note.resolution.status === "detached";
      const context = this.doc.createElement("div");
      context.className = "wm-note-context";
      context.textContent = note.annotation.anchor.textQuote?.exact?.slice(0, 90) || note.annotation.anchor.fingerprint?.tag || "";
      if (detached) {
        const badge = this.doc.createElement("span");
        badge.className = "wm-badge wm-badge-detached";
        badge.textContent = "detached";
        context.appendChild(badge);
      }
      if (note.annotation.attachments?.length) {
        const badge = this.doc.createElement("span");
        badge.className = "wm-badge wm-badge-attach";
        badge.textContent = `📎 ${note.annotation.attachments.length}`;
        context.appendChild(badge);
      }
      card.appendChild(context);

      const body = this.doc.createElement("div");
      body.className = "wm-note-body";
      body.innerHTML = renderMarkdown(note.annotation.body.text); // renderMarkdown escapes all input
      card.appendChild(body);

      // Attachment previews (SVG strings rendered via <img>, so they can never execute script).
      for (const att of note.annotation.attachments ?? []) {
        const preview = (att as { preview?: unknown }).preview;
        if (typeof preview === "string" && preview.trimStart().startsWith("<svg")) {
          const img = this.doc.createElement("img");
          img.className = "wm-note-preview";
          img.alt = `${att.type} attachment preview`;
          img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(preview)))}`;
          card.appendChild(img);
        }
      }

      const actions = this.doc.createElement("div");
      actions.className = "wm-note-actions";
      const id = note.annotation.id;
      if (!detached) {
        actions.appendChild(this.makeButton("Edit", "wm-btn", () => this.noteCallbacks.onEdit(id)));
      } else {
        actions.appendChild(this.makeButton("Re-attach", "wm-btn", () => this.noteCallbacks.onReattach(id)));
      }
      actions.appendChild(this.makeButton("Copy link", "wm-btn", () => this.noteCallbacks.onCopyLink(id)));
      for (const action of this.noteActions) {
        const label = typeof action.label === "function" ? action.label(note.annotation) : action.label;
        actions.appendChild(this.makeButton(label, "wm-btn", () => action.onClick(note.annotation)));
      }
      actions.appendChild(this.makeButton("Delete", "wm-btn wm-danger", () => this.noteCallbacks.onDelete(id)));
      card.appendChild(actions);

      const navigate = () => {
        if (!detached) this.noteCallbacks.onNavigate(id);
      };
      card.addEventListener("click", (e) => {
        if ((e.target as Element).closest("button")) return;
        navigate();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate();
        }
      });

      this.sidebarBody.appendChild(card);
    }
  }
}
