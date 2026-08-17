import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// jsdom leaves isContentEditable undefined; the browser derives it from the
// nearest editable ancestor, which is what the resolver reads.
function fakeContentEditable(): void {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return !!this.closest('[contenteditable=""],[contenteditable="true"]');
    },
  });
}

describe("rich-text editors", () => {
  const resolver = createDefaultBlockResolver();
  const noExclude = { exclude: () => false };

  beforeEach(() => {
    fakeRects();
    fakeContentEditable();
  });

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).isContentEditable;
  });

  // Notion wraps the whole page body in one contenteditable and nests every text
  // block in anonymous divs, the innermost carrying role="textbox".
  it("resolves a text block inside a page-wide contenteditable", () => {
    const filler = "Body text that makes this editable root document-sized. ".repeat(12);
    document.body.innerHTML = `
      <div contenteditable="true" role="group">
        <div id="block" data-block-id="abc" class="notion-text-block">
          <div><div><div id="leaf" contenteditable="true" role="textbox">Add the Order and OrderLine models with their migration.</div></div></div>
        </div>
        <div data-block-id="def">${filler}</div>
      </div>
    `;
    const block = resolver(document.getElementById("leaf")!, noExclude);
    expect(block?.id).toBe("block");
  });

  it("still refuses a short standalone contenteditable field", () => {
    document.body.innerHTML = `<div id="composer" contenteditable="true" role="textbox">Reply to this thread</div>`;
    const block = resolver(document.getElementById("composer")!, noExclude);
    expect(block).toBeNull();
  });
});
