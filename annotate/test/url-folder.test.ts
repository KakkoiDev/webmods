import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOT,
  FOLDER_MAX,
  HOST_MAX,
  SLUG_MAX,
  colocatedFolder,
  folderFor,
  parseRoot,
  sanitizeSegment,
  urlSegments,
} from "../src/url-folder";

const root = [DEFAULT_ROOT];
const HASH = /-[0-9a-z]{8}$/;

describe("sanitizeSegment", () => {
  it("lowercases, maps outside [a-z0-9._-] to '-', collapses runs, strips edge dots and dashes", () => {
    expect(sanitizeSegment("Hello World!!")).toBe("hello-world");
    expect(sanitizeSegment("/docs//API v2/")).toBe("docs-api-v2");
    expect(sanitizeSegment("a..b_c")).toBe("a..b_c");
  });

  it("turns '.' and '..' into nothing", () => {
    expect(sanitizeSegment(".")).toBe("");
    expect(sanitizeSegment("..")).toBe("");
    expect(sanitizeSegment(".hidden")).toBe("hidden");
  });
});

describe("urlSegments", () => {
  it("uses the lowercase host and a slug of the path", () => {
    expect(urlSegments("https://Docs.Example.COM/Guide/Intro.html")).toEqual(["docs.example.com", "guide-intro.html"]);
    expect(urlSegments("https://example.com/")).toEqual(["example.com", "index"]);
  });

  it("drops credentials and the fragment, and keeps the port", () => {
    expect(urlSegments("http://user:secret@localhost:8080/a#frag")).toEqual(["localhost-8080", "a"]);
  });

  it("cannot traverse: dot segments in the path collapse into the slug", () => {
    const [host, slug] = urlSegments("https://example.com/%2e%2e/%2E%2E/etc/passwd");
    expect(host).toBe("example.com");
    expect(slug).not.toContain("/");
    expect(slug).not.toMatch(/^\.+$/);
    expect(folderFor("https://example.com/../../etc", root).split("/")).not.toContain("..");
  });

  it("hashes the query so two URLs differing only by query never share a folder", () => {
    const a = urlSegments("https://example.com/search?q=one")[1];
    const b = urlSegments("https://example.com/search?q=two")[1];
    expect(a).toMatch(/^search-[0-9a-z]{8}$/);
    expect(a).not.toBe(b);
    expect(urlSegments("https://example.com/search?")[1]).toBe("search");
  });

  it("hashes non-ASCII paths instead of collapsing them together", () => {
    const a = urlSegments("https://example.com/日本語")[1];
    const b = urlSegments("https://example.com/中文")[1];
    expect(a).toMatch(/^index-[0-9a-z]{8}$/);
    expect(a).not.toBe(b);
    expect(urlSegments("https://example.com/café")[1]).toMatch(/^caf-[0-9a-z]{8}$/);
  });

  it("keeps punycode hosts and hashes IPv6 hosts", () => {
    expect(urlSegments("https://bücher.example/x")[0]).toBe("xn--bcher-kva.example");
    expect(urlSegments("http://[::1]:3000/x")[0]).toMatch(HASH);
  });

  it("caps long hosts and paths with a hash, and the whole folder stays under FOLDER_MAX", () => {
    const longPath = "/" + "segment/".repeat(40);
    const [host, slug] = urlSegments(`https://${"a".repeat(60)}.example.com${longPath}`);
    expect(host.length).toBeLessThanOrEqual(HOST_MAX);
    expect(host).toMatch(HASH);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(slug).toMatch(HASH);
    expect(urlSegments(`https://example.com${longPath}x`)[1]).not.toBe(slug);
    const folder = folderFor(`https://${"a".repeat(60)}.example.com${longPath}?q=1`, parseRoot("a".repeat(40)));
    expect(folder.length).toBeLessThanOrEqual(FOLDER_MAX);
  });

  it("files file:// pages under a 'file' host", () => {
    expect(urlSegments("file:///Users/Me/My%20Docs/plan.html")).toEqual(["file", "users-me-my-docs-plan.html"]);
  });
});

describe("parseRoot", () => {
  it("defaults when blank and accepts nested clean folders", () => {
    expect(parseRoot("")).toEqual([DEFAULT_ROOT]);
    expect(parseRoot(null)).toEqual([DEFAULT_ROOT]);
    expect(parseRoot(" team/notes/ ")).toEqual(["team", "notes"]);
  });

  it("rejects absolute paths, traversal, unclean segments and overlong roots", () => {
    expect(() => parseRoot("/etc")).toThrow("relative");
    expect(() => parseRoot("C:/x")).toThrow("relative");
    expect(() => parseRoot("a/../b")).toThrow('".."');
    expect(() => parseRoot("./a")).toThrow('"."');
    expect(() => parseRoot("My Notes")).toThrow("may only use");
    expect(() => parseRoot("a".repeat(41))).toThrow("longer than 40");
  });
});

describe("colocatedFolder", () => {
  it("puts notes for a doc under the root next to the doc", () => {
    const path = "/Users/me/Downloads/firstmate-annotate/docs/plan/doc.html";
    expect(colocatedFolder(path, root)).toEqual(["firstmate-annotate", "docs", "plan"]);
    expect(folderFor("file://" + path, root, path)).toBe("firstmate-annotate/docs/plan");
  });

  it("falls back to file/<slug> outside the root, directly in the root, or under an unclean folder", () => {
    for (const path of [
      "/Users/me/elsewhere/doc.html",
      "/Users/me/Downloads/firstmate-annotate/doc.html",
      "/Users/me/Downloads/firstmate-annotate/My Plan/doc.html",
    ]) {
      expect(colocatedFolder(path, root)).toBeNull();
      expect(folderFor("file://" + encodeURI(path), root, path).startsWith("firstmate-annotate/file/")).toBe(true);
    }
  });
});
