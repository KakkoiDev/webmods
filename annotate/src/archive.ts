import type { Annotation } from "./types";

/** Metadata key holding the archive timestamp. Absent means active. */
export const ARCHIVED_KEY = "archived";

export function isArchived(annotation: Annotation): boolean {
  return typeof annotation.metadata?.[ARCHIVED_KEY] === "number";
}

export function archivedAt(annotation: Annotation): number | null {
  const value = annotation.metadata?.[ARCHIVED_KEY];
  return typeof value === "number" ? value : null;
}
