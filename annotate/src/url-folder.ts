import { hashString } from "./page-identity";

/** Root folder under the browser's Downloads folder when none is configured. */
export const DEFAULT_ROOT = "firstmate-annotate";

export const ROOT_MAX = 40;
export const HOST_MAX = 48;
export const SLUG_MAX = 64;
/** ROOT_MAX + HOST_MAX + SLUG_MAX + two separators. */
export const FOLDER_MAX = ROOT_MAX + HOST_MAX + SLUG_MAX + 2;

const HASH_LEN = 8;

function shortHash(input: string): string {
  return hashString(input).slice(-HASH_LEN);
}

/**
 * Lowercase, map each run of characters outside [a-z0-9._-] to one "-", and
 * strip leading and trailing "." and "-". Dashes already in the input stay, so
 * punycode hosts ("xn--...") survive unchanged. The strip is what turns "."
 * and ".." (and hidden-file names) into "", so no segment can traverse.
 */
export function sanitizeSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

/** Cap `segment` at `max` characters, keeping it unique with a hash of `source` when cut or when `forceHash`. */
function capped(segment: string, max: number, source: string, forceHash: boolean): string {
  if (!forceHash && segment.length <= max) return segment;
  const head = segment.slice(0, max - HASH_LEN - 1).replace(/[.-]+$/, "");
  return head ? `${head}-${shortHash(source)}` : shortHash(source);
}

/** Validate a configured root: relative, "/"-separated, each segment already clean. Blank means the default. */
export function parseRoot(input: string | null | undefined): string[] {
  const text = (input ?? "").trim();
  if (!text) return [DEFAULT_ROOT];
  if (text.startsWith("/") || text.startsWith("\\") || /^[a-z]:/i.test(text)) {
    throw new Error(`root must be relative to the Downloads folder: ${text}`);
  }
  const segments = text.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new Error(`root must not contain "${segment}": ${text}`);
    if (sanitizeSegment(segment) !== segment) {
      throw new Error(`root segment "${segment}" may only use a-z, 0-9, ".", "_" and "-", and not start or end with "." or "-"`);
    }
  }
  if (!segments.length) return [DEFAULT_ROOT];
  if (segments.join("/").length > ROOT_MAX) throw new Error(`root is longer than ${ROOT_MAX} characters: ${text}`);
  return segments;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * `[host, slug]` for a page URL. Credentials and the fragment are dropped. A
 * segment gets a short hash whenever it shows less than the URL carries: a query
 * string, non-ASCII path characters, an IPv6 host, or a value over the cap.
 */
export function urlSegments(url: string): [string, string] {
  const parsed = new URL(url);
  let host: string;
  if (parsed.protocol === "file:") host = "file";
  else {
    const raw = parsed.port ? `${parsed.hostname}-${parsed.port}` : parsed.hostname;
    const clean = sanitizeSegment(raw);
    host = capped(clean || "unknown-host", HOST_MAX, raw, clean !== raw.toLowerCase());
  }
  const path = safeDecode(parsed.pathname);
  const lossy = parsed.search.length > 1 || /[^\x00-\x7f]/.test(path);
  const slug = capped(sanitizeSegment(path) || "index", SLUG_MAX, parsed.pathname + parsed.search, lossy);
  return [host, slug];
}

/**
 * For a file:// page stored under `<...>/<root>/<a>/<b>/doc.html`, the doc's own
 * directory relative to Downloads (`<root>/<a>/<b>`), so its notes land next to it.
 * Null when the path has no root segment run, or any folder under it is not clean.
 */
export function colocatedFolder(localPath: string, root: string[]): string[] | null {
  const dirs = localPath.split("/").filter(Boolean).slice(0, -1);
  for (let at = dirs.length - root.length; at >= 0; at--) {
    if (!root.every((segment, i) => dirs[at + i] === segment)) continue;
    const rest = dirs.slice(at + root.length);
    if (!rest.length || rest.some((segment) => sanitizeSegment(segment) !== segment)) return null;
    const folder = [...root, ...rest];
    return folder.join("/").length <= FOLDER_MAX ? folder : null;
  }
  return null;
}

/** Folder, relative to the Downloads folder, that a send from `url` lands in. */
export function folderFor(url: string, root: string[], localPath: string | null = null): string {
  const colocated = localPath ? colocatedFolder(localPath, root) : null;
  return (colocated ?? [...root, ...urlSegments(url)]).join("/");
}
