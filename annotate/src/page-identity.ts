import type { PageIdentity, PageIdentityResolver } from "./types";
import { INLINE_FRAGMENT_PARAM, NOTE_FRAGMENT_PARAM } from "./types";

const DEFAULT_TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "igshid",
];

/**
 * Strip the library's own fragment params from a hash string.
 * `#wm-note=abc` -> "", `#section&wm-note=abc` -> "#section".
 */
export function stripOwnFragment(hash: string): string {
  if (!hash) return "";
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const kept = raw
    .split("&")
    .filter((part) => {
      const key = part.split("=")[0];
      return key !== NOTE_FRAGMENT_PARAM && key !== INLINE_FRAGMENT_PARAM;
    })
    .join("&");
  return kept ? `#${kept}` : "";
}

export function normalizeUrl(url: string, extraStripParams: string[] = []): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }

  const strip = new Set([...DEFAULT_TRACKING_PARAMS, ...extraStripParams]);
  const params = new URLSearchParams(u.search);
  for (const key of [...params.keys()]) {
    if (strip.has(key)) params.delete(key);
  }
  params.sort();
  const search = params.toString();

  u.hash = "";
  let pathname = u.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  return `${u.origin}${pathname}${search ? `?${search}` : ""}`;
}

/** Deterministic short hash so the same normalized URL always maps to the same page id. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).padStart(13, "0");
}

export function createDefaultPageIdentityResolver(extraStripParams: string[] = []): PageIdentityResolver {
  return (location, document): PageIdentity => {
    const cleanHash = stripOwnFragment(location.hash);
    const url = `${location.origin}${location.pathname}${location.search}${cleanHash}`;
    const normalizedUrl = normalizeUrl(url, extraStripParams);
    return {
      id: `pg_${hashString(normalizedUrl)}`,
      url,
      normalizedUrl,
      title: document.title || undefined,
    };
  };
}
