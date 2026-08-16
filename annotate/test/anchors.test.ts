import { beforeEach, describe, expect, it } from "vitest";
import { createAnchor, resolveAnchor, textSimilarity } from "../src/anchors";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("textSimilarity", () => {
  it("returns 1 for identical and ~0 for unrelated text", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
    expect(textSimilarity("hello world", "zzqqxx")).toBeLessThan(0.1);
  });

  it("is high for near-identical text", () => {
    expect(textSimilarity("The quick brown fox jumps", "The quick brown fox jumped")).toBeGreaterThan(0.8);
  });
});

describe("createAnchor / resolveAnchor", () => {
  beforeEach(() => {
    setBody(`
      <main>
        <h2>Authentication</h2>
        <p id="intro">Authentication is handled by the session service and refresh tokens.</p>
        <p>Second paragraph about tokens and other unrelated words entirely.</p>
        <h2>Database</h2>
        <p>The cache layer sits in front of the primary database instance.</p>
      </main>
    `);
  });

  it("creates an anchor with selector, quote, and fingerprint", () => {
    const el = document.getElementById("intro")!;
    const anchor = createAnchor(el, "https://example.com/doc");
    expect(anchor.selector).toContain("#intro");
    expect(anchor.textQuote?.exact).toContain("Authentication is handled");
    expect(anchor.fingerprint?.tag).toBe("p");
    expect(anchor.fingerprint?.nearbyHeading).toBe("Authentication");
  });

  it("resolves via selector when the DOM is unchanged", () => {
    const el = document.getElementById("intro")!;
    const anchor = createAnchor(el, "https://example.com/doc");
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.element).toBe(el);
  });

  it("recovers via exact text quote when the selector breaks", () => {
    const el = document.getElementById("intro")!;
    const anchor = createAnchor(el, "https://example.com/doc");
    // Restructure: id gone, element moved inside a new wrapper.
    setBody(`
      <div class="wrapper">
        <section>
          <p>Authentication is handled by the session service and refresh tokens.</p>
        </section>
      </div>
    `);
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.element.textContent).toContain("Authentication is handled");
      expect(res.confidence).toBe(1);
    }
  });

  it("recovers fuzzily when the text changed slightly", () => {
    const el = document.getElementById("intro")!;
    const anchor = createAnchor(el, "https://example.com/doc");
    setBody(`
      <h2>Authentication</h2>
      <p>Authentication is now handled by the session service and refresh tokens.</p>
    `);
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.element.textContent).toContain("session service");
      expect(res.confidence).toBeGreaterThan(0.6);
      expect(res.confidence).toBeLessThan(1);
    }
  });

  it("reports detached instead of guessing when content is gone", () => {
    const el = document.getElementById("intro")!;
    const anchor = createAnchor(el, "https://example.com/doc");
    setBody(`<p>Completely different page content about gardening and weather patterns.</p>`);
    const res = resolveAnchor(anchor, document);
    expect(res.status).toBe("detached");
  });

  it("does not resolve a stale selector pointing at different content", () => {
    const el = document.getElementById("intro")!;
    const anchor = createAnchor(el, "https://example.com/doc");
    setBody(`<p id="intro">Totally unrelated replacement text about gardening tips.</p>`);
    const res = resolveAnchor(anchor, document);
    // #intro exists but its text no longer matches -> must not resolve to it with high confidence
    expect(res.status).toBe("detached");
  });
});
