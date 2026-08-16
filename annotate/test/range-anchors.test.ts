// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createAnchor, normalizeText, resolveAnchor } from "../src/anchors";
import { blockTextWithMap, buildRange, createRangeAnchor, rangeOffsets, resolveRangeInBlock } from "../src/ranges";

const setBody = (html: string) => (document.body.innerHTML = html);

/** Select `needle` inside a block by walking its text nodes. */
function selectText(block: Element, needle: string): Range {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n = walker.nextNode() as Text | null;
  while (n) {
    nodes.push(n);
    n = walker.nextNode() as Text | null;
  }
  const raw = nodes.map((t) => t.data).join("");
  const at = raw.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" not present in block`);

  const locate = (index: number) => {
    let seen = 0;
    for (const node of nodes) {
      if (index <= seen + node.data.length) return { node, offset: index - seen };
      seen += node.data.length;
    }
    const last = nodes[nodes.length - 1];
    return { node: last, offset: last.data.length };
  };
  const from = locate(at);
  const to = locate(at + needle.length);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

describe("blockTextWithMap", () => {
  beforeEach(() => setBody(`<p id="p">  ab <em>cd</em>\n   ef  </p>`));

  it("normalizes exactly like normalizeText", () => {
    const block = document.getElementById("p")!;
    const map = blockTextWithMap(block);
    expect(map.text).toBe(normalizeText(block.textContent || ""));
    expect(map.text).toBe("ab cd ef");
  });

  it("maps normalized offsets back to the right text nodes", () => {
    const map = blockTextWithMap(document.getElementById("p")!);
    const range = buildRange(map, map.text.indexOf("cd"), map.text.indexOf("cd") + 2)!;
    expect(range.toString()).toBe("cd");
    expect(range.startContainer.parentElement!.tagName).toBe("EM");
  });

  it("builds ranges spanning multiple text nodes", () => {
    const map = blockTextWithMap(document.getElementById("p")!);
    const range = buildRange(map, 0, map.text.length)!;
    expect(normalizeText(range.toString())).toBe("ab cd ef");
  });
});

describe("createRangeAnchor", () => {
  beforeEach(() =>
    setBody(`
      <article>
        <h2>Authentication</h2>
        <p id="p">Tokens are validated at the edge before any request reaches the application servers.</p>
      </article>`)
  );

  it("captures the selection, its offsets and local context", () => {
    const block = document.getElementById("p")!;
    const range = selectText(block, "validated at the edge");
    const anchor = createRangeAnchor(range, block, createAnchor(block, "https://example.com/d"));

    expect(anchor.kind).toBe("range");
    expect(anchor.textQuote?.exact).toBe("validated at the edge");
    expect(anchor.textQuote?.prefix).toContain("Tokens are ");
    expect(anchor.textQuote?.suffix).toContain(" before any request");
    expect(anchor.textPosition).toEqual({
      start: "Tokens are ".length,
      end: "Tokens are ".length + "validated at the edge".length,
    });
    // Block-level identity is preserved for the first resolution stage.
    expect(anchor.selector).toContain("#p");
    expect(anchor.fingerprint?.tag).toBe("p");
  });

  it("captures selections that span inline elements", () => {
    setBody(`<p id="p">alpha <em>beta</em> gamma delta</p>`);
    const block = document.getElementById("p")!;
    const anchor = createRangeAnchor(selectText(block, "beta gamma"), block, createAnchor(block, "u"));
    expect(anchor.textQuote?.exact).toBe("beta gamma");

    const back = resolveRangeInBlock(block, anchor)!;
    expect(normalizeText(back.toString())).toBe("beta gamma");
  });
});

describe("range resolution", () => {
  const url = "https://example.com/d";
  const html = `
    <article>
      <h2>Database</h2>
      <p id="p">The cache layer sits in front of the primary database instance and absorbs most reads.</p>
    </article>`;

  function anchorFor(needle: string) {
    setBody(html);
    const block = document.getElementById("p")!;
    return createRangeAnchor(selectText(block, needle), block, createAnchor(block, url));
  }

  it("round-trips on an unchanged page", () => {
    const anchor = anchorFor("primary database instance");
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.range).toBeTruthy();
      expect(res.range!.toString()).toBe("primary database instance");
    }
  });

  it("survives edits elsewhere in the same block", () => {
    const anchor = anchorFor("primary database instance");
    setBody(html.replace("absorbs most reads", "absorbs nearly every read request"));
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.range?.toString()).toBe("primary database instance");
  });

  it("degrades to block level (no range) when the quoted text is gone", () => {
    const anchor = anchorFor("primary database instance");
    setBody(`
      <article>
        <h2>Database</h2>
        <p id="p">The cache layer sits in front of storage and absorbs most reads.</p>
      </article>`);
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.range).toBeUndefined();
      expect(res.confidence).toBeLessThan(1);
    }
  });

  it("disambiguates duplicate occurrences using prefix/suffix", () => {
    setBody(`<p id="p">alpha target omega and then beta target zeta again</p>`);
    const block = document.getElementById("p")!;
    const secondStart = block.textContent!.indexOf("target", block.textContent!.indexOf("target") + 1);
    const range = document.createRange();
    const textNode = block.firstChild as Text;
    range.setStart(textNode, secondStart);
    range.setEnd(textNode, secondStart + "target".length);
    const anchor = createRangeAnchor(range, block, createAnchor(block, url));
    expect(anchor.textQuote?.prefix).toContain("beta ");

    // Re-render (fresh nodes) then resolve: must pick the SECOND "target".
    setBody(`<p id="p">alpha target omega and then beta target zeta again</p>`);
    const resolvedRange = resolveRangeInBlock(document.getElementById("p")!, anchor)!;
    expect(resolvedRange).toBeTruthy();
    const map = blockTextWithMap(document.getElementById("p")!);
    expect(rangeOffsets(resolvedRange, map)!.start).toBe(map.text.indexOf("beta target") + "beta ".length);
  });

  it("recovers fuzzily from a small wording change inside the quote", () => {
    const anchor = anchorFor("absorbs most reads");
    setBody(html.replace("absorbs most reads", "absorbs most read traffic"));
    const range = resolveRangeInBlock(document.getElementById("p")!, anchor);
    expect(range).toBeTruthy();
    expect(range!.toString()).toContain("absorbs most read");
  });

  it("leaves legacy block anchors untouched", () => {
    setBody(html);
    const block = document.getElementById("p")!;
    const legacy = createAnchor(block, url);
    expect(legacy.kind).toBeUndefined();
    const res = resolveAnchor(legacy, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.range).toBeUndefined();
      expect(res.element).toBe(block);
    }
  });
});
