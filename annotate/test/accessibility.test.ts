// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotator } from "../src/annotator";
import { createMemoryStorage } from "../src/storage";
import type { Annotator } from "../src/types";

let annotator: Annotator | null = null;

afterEach(() => {
  annotator?.destroy();
  annotator = null;
  document.body.innerHTML = "";
});

const shadow = () => document.querySelector("[data-wm-annotate-ui]")!.shadowRoot!;

function key(init: KeyboardEventInit & { key: string }, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("keyboard access", () => {
  it("toggles annotate mode with the configured shortcut", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    key({ key: "a", altKey: true, shiftKey: true });
    expect(annotator.getMode()).toBe("annotate");
    key({ key: "a", altKey: true, shiftKey: true });
    expect(annotator.getMode()).toBe("explore");
  });

  it("toggles the sidebar with alt+shift+s and honors an override", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(false);
    key({ key: "s", altKey: true, shiftKey: true });
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(true);

    annotator.destroy();
    annotator = createAnnotator({ storage: createMemoryStorage(), shortcuts: { sidebar: null } });
    key({ key: "s", altKey: true, shiftKey: true });
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(false);
  });

  it("ignores shortcuts while typing in a field", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const input = document.createElement("input");
    document.body.appendChild(input);
    key({ key: "a", altKey: true, shiftKey: true }, input);
    expect(annotator.getMode()).toBe("explore");
  });

  it("Escape closes annotate mode first, then the sidebar", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    annotator.openSidebar();
    annotator.enter();

    key({ key: "Escape" });
    expect(annotator.getMode()).toBe("explore");
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(true);

    key({ key: "Escape" });
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(false);
  });

  it("announces mode changes in an aria-live region", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const live = shadow().querySelector("[aria-live=polite]")!;
    annotator.enter();
    expect(live.textContent).toMatch(/on/i);
    annotator.exit();
    expect(live.textContent).toMatch(/off/i);
  });

  it("gives sidebar tabs a roving tabindex", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    annotator.use({
      name: "extra",
      setup: (ctx) => ctx.addSidebarTab({ id: "extra", label: "Extra", render: () => {} }),
    });
    annotator.openSidebar();

    const tabs = [...shadow().querySelectorAll<HTMLElement>(".wm-tab[role=tab]")];
    expect(tabs.map((t) => t.dataset.tabId)).toEqual(["notes", "extra"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);

    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const after = [...shadow().querySelectorAll<HTMLElement>(".wm-tab[role=tab]")];
    expect(after.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(after.map((t) => t.tabIndex)).toEqual([-1, 0]);
  });

  it("reveals the corner widget after a dwell in the bottom-right and drives mode plus sidebar", async () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    const corner = () => shadow().querySelector(".wm-corner")!;
    const open = () => corner().classList.contains("wm-corner-open");
    // jsdom has no PointerEvent constructor; a MouseEvent carries the same coordinates.
    const move = (x: number, y: number) =>
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    expect(open()).toBe(false);
    move(vw - 5, vh - 5);
    expect(open()).toBe(false); // still dwelling
    await new Promise((r) => setTimeout(r, 300));
    expect(open()).toBe(true);

    const toggle = corner().querySelector<HTMLElement>("[role=switch]")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(annotator.getMode()).toBe("annotate");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    corner().querySelector<HTMLElement>(".wm-corner-sidebar")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(true);

    move(10, 10);
    await new Promise((r) => setTimeout(r, 450));
    expect(open()).toBe(false);
  });

  it("omits the corner widget when it is turned off", () => {
    annotator = createAnnotator({ storage: createMemoryStorage(), ui: { cornerWidget: false } });
    expect(shadow().querySelector(".wm-corner")).toBeNull();
  });

  it("shows header actions only on the tabs they belong to", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    annotator.use({
      name: "extra",
      setup: (ctx) => {
        ctx.addSidebarTab({ id: "extra", label: "Extra", render: () => {} });
        ctx.addHeaderAction({ id: "notes-only", label: "MD", title: "Export this site", tabs: ["notes"], onClick: () => {} });
        ctx.addHeaderAction({ id: "everywhere", label: "*", onClick: () => {} });
      },
    });
    annotator.openSidebar();

    const ids = () => [...shadow().querySelectorAll<HTMLElement>(".wm-header-btn")].map((b) => b.dataset.headerActionId);
    expect(ids()).toEqual(["notes-only", "everywhere"]);
    const tabs = [...shadow().querySelectorAll<HTMLElement>(".wm-tab[role=tab]")];
    tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(ids()).toEqual(["everywhere"]);
  });

  it("exposes activateSidebarTab to plugins", () => {
    annotator = createAnnotator({ storage: createMemoryStorage() });
    annotator.use({
      name: "extra",
      setup: (ctx) => {
        ctx.addSidebarTab({ id: "extra", label: "Extra", render: (c) => void (c.textContent = "hello") });
        ctx.activateSidebarTab("extra");
      },
    });
    expect(shadow().querySelector(".wm-sidebar")!.classList.contains("wm-open")).toBe(true);
    expect(shadow().querySelector(".wm-sidebar-body")!.textContent).toBe("hello");
  });
});
