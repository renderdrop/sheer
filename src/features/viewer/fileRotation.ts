import { normalizeRotation, type Rotation } from './transform';

/**
 * The page's own `/Rotate` (ARCHITECTURE `PageSlotInfo.rotation`). `get_page_sizes` already reports the size with it applied and the
 * renderer draws it, but the frontend has no command that reports the angle itself yet, so every page is taken as unrotated and
 * the text, hit and link overlays of a page with `/Rotate` are off by that turn. When Rust reports it (the planned `pages` list of
 * `DocumentInfo`), this is the one place that learns it; every overlay already goes through the transform helper with it.
 */
const known = new Map<string, number>();

const keyOf = (docId: number, page: number) => `${docId}:${page}`;

/** The file's rotation of a page, 0 when it is not known. */
export function fileRotationOf(docId: number, page: number): Rotation {
  return normalizeRotation(known.get(keyOf(docId, page)) ?? 0);
}

/** Records what Rust reported for a page. */
export function setFileRotation(docId: number, page: number, degrees: number): void {
  known.set(keyOf(docId, page), degrees);
}

/** Forgets what is known about a document. */
export function forgetFileRotations(docId: number): void {
  for (const key of [...known.keys()]) if (key.startsWith(`${docId}:`)) known.delete(key);
}
