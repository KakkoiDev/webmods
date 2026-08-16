// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotator } from "../src/annotator";
import { createAnchor } from "../src/anchors";
import { createMemoryStorage } from "../src/storage";
import type { Annotation, AnnotationStorage, Annotator, PageIdentity } from "../src/types";

let annotator: Annotator | null = null;

afterEach(() => {
  annotator?.destroy();
  annotator = null;
  document.body.innerHTML = "";
});

/**
 * Wraps a storage adapter to count getPage() calls (one per refresh pass).
 * Delegates explicitly — DocumentStorage's methods live on its prototype, so
 * spreading the instance would drop them.
 */
function countingStorage(inner: AnnotationStorage): AnnotationStorage & { calls: () => number } {
  let calls = 0;
  return {
    getPage(page: PageIdentity): Promise<Annotation[]> {
      calls++;
      return inner.getPage(page);
    },
    get: (id) => inner.get(id),
    save: (annotation, page) => inner.save(annotation, page),
    delete: (id) => inner.delete(id),
    calls: () => calls,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe("dynamic content re-resolution", () => {
  it("attaches a note when its target renders after load", async () => {
    document.body.innerHTML = `<p id="target">Late rendered paragraph with distinctive wording here.</p>`;
    const storage = createMemoryStorage();
    const anchorSource = createAnchor(document.getElementById("target")!, "http://localhost/");

    // Page starts WITHOUT the annotated content (SPA still fetching).
    document.body.innerHTML = `<div id="app">loading…</div>`;
    annotator = createAnnotator({ storage });
    await annotator.createNote(anchorSource, "waits for content");
    expect(annotator.getNotes()[0].resolution.status).toBe("detached");

    // Content mounts a moment later.
    document.getElementById("app")!.innerHTML =
      `<p id="target">Late rendered paragraph with distinctive wording here.</p>`;

    const attached = await waitFor(() => annotator!.getNotes()[0]?.resolution.status === "resolved");
    expect(attached).toBe(true);
  });

  it("stops observing once everything is attached", async () => {
    document.body.innerHTML = `<p id="target">Observed paragraph that shows up late in the page.</p>`;
    const storage = countingStorage(createMemoryStorage());
    const anchor = createAnchor(document.getElementById("target")!, "http://localhost/");

    document.body.innerHTML = `<div id="app"></div>`;
    annotator = createAnnotator({ storage });
    await annotator.createNote(anchor, "note");

    document.getElementById("app")!.innerHTML =
      `<p id="target">Observed paragraph that shows up late in the page.</p>`;
    await waitFor(() => annotator!.getNotes()[0]?.resolution.status === "resolved");

    const settled = storage.calls();
    // Further unrelated DOM churn must not trigger more refresh passes.
    for (let i = 0; i < 5; i++) document.body.appendChild(document.createElement("span"));
    await new Promise((r) => setTimeout(r, 700));
    expect(storage.calls()).toBe(settled);
  });

  it("caps retries when the target never appears", async () => {
    document.body.innerHTML = `<p id="target">This content is never coming back at all.</p>`;
    const storage = countingStorage(createMemoryStorage());
    const anchor = createAnchor(document.getElementById("target")!, "http://localhost/");

    document.body.innerHTML = `<div id="app"></div>`;
    annotator = createAnnotator({ storage });
    await annotator.createNote(anchor, "orphan");
    const afterCreate = storage.calls();

    for (let i = 0; i < 10; i++) {
      document.body.appendChild(document.createElement("div"));
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 800));

    // At most OBSERVER_MAX_RETRIES (5) extra passes, never an unbounded loop.
    expect(storage.calls() - afterCreate).toBeLessThanOrEqual(5);
    expect(annotator.getNotes()[0].resolution.status).toBe("detached");
  });
});
