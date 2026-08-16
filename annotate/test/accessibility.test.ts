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
