import { describe, expect, it } from "vitest";
import { hashString, normalizeUrl, stripOwnFragment } from "../src/page-identity";

describe("normalizeUrl", () => {
  it("strips tracking params but keeps content params", () => {
    const url = "https://example.com/article?id=42&utm_source=x&utm_campaign=y&fbclid=z";
    expect(normalizeUrl(url)).toBe("https://example.com/article?id=42");
  });

  it("strips extra configured params", () => {
    expect(normalizeUrl("https://example.com/a?session=1&id=2", ["session"])).toBe("https://example.com/a?id=2");
  });

  it("sorts query params for stability", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe(normalizeUrl("https://example.com/a?a=1&b=2"));
  });

  it("drops the hash and trailing slash", () => {
    expect(normalizeUrl("https://example.com/article/#section")).toBe("https://example.com/article");
  });

  it("returns non-URL input unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("stripOwnFragment", () => {
  it("removes wm-note while keeping other fragments", () => {
    expect(stripOwnFragment("#section&wm-note=abc")).toBe("#section");
    expect(stripOwnFragment("#wm-note=abc")).toBe("");
    expect(stripOwnFragment("#wm=payload")).toBe("");
    expect(stripOwnFragment("#section")).toBe("#section");
    expect(stripOwnFragment("")).toBe("");
  });
});

describe("hashString", () => {
  it("is deterministic and distinguishes inputs", () => {
    expect(hashString("https://example.com/a")).toBe(hashString("https://example.com/a"));
    expect(hashString("https://example.com/a")).not.toBe(hashString("https://example.com/b"));
  });
});
