import { beforeEach, describe, expect, it } from "vitest";
import { buildExcludeFn, createDefaultBlockResolver } from "../src/blocks";

// jsdom has no layout: give elements a fake but plausible rect so visibility
// and size scoring behave like a real page.
function fakeRects(): void {
  Element.prototype.getBoundingClientRect = function () {
    const textLen = (this.textContent || "").length;
    const height = Math.max(20, Math.min(600, textLen / 2));
    return { top: 100, left: 0, right: 600, bottom: 100 + height, width: 600, height, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
  };
}

describe("default block resolver", () => {
  const resolver = createDefaultBlockResolver();
  const noExclude = { exclude: () => false };

  beforeEach(() => {
    fakeRects();
    document.body.innerHTML = `
      <article>
        <p id="para">A paragraph with a <em id="em">highlighted</em> word inside meaningful text.</p>
        <ul><li id="item">List item content that says something useful.</li></ul>
        <form><input id="input" type="text"></form>
      </article>
    `;
  });

  it("walks up from inline elements to the containing paragraph", () => {
    const block = resolver(document.getElementById("em")!, noExclude);
    expect(block?.id).toBe("para");
  });

  it("picks the list item over its list", () => {
    const block = resolver(document.getElementById("item")!, noExclude);
    expect(block?.id).toBe("item");
  });

  it("never returns form controls", () => {
    const block = resolver(document.getElementById("input")!, noExclude);
    expect(block?.tagName).not.toBe("INPUT");
  });

  it("honors exclusion rules", () => {
    const exclude = buildExcludeFn(["article"]);
    const block = resolver(document.getElementById("para")!, { exclude });
    expect(block).toBeNull();
  });
});
