import { normalizeRotation, type Rotation } from './transform';

/**
 * The page's own `/Rotate` (ARCHITECTURE `PageSlotInfo.rotation`). `get_page_sizes` reports the size with it applied and the
 * renderer draws it, but the overlays (text, search hits, links) are in page space, before it, and have to be turned by it.
 * Rust reports it with the text layer of the page (`get_text_layer`, the one answer that already loads the page and has the
 * boxes it applies to): the text cache records it here as a layer arrives, and this is the one place that knows it. Until a
 * page's rotation is known (`hasFileRotation`) it is taken as 0, and the overlays that would be misplaced by it wait.
 */
const known = new Map<string, number>();

const keyOf = (docId: number, page: number) => `${docId}:${page}`;

/** The file's rotation of a page, 0 when it is not known. */
export function fileRotationOf(docId: number, page: number): Rotation {
  return normalizeRotation(known.get(keyOf(docId, page)) ?? 0);
}

/** Whether Rust has reported the rotation of a page. */
export function hasFileRotation(docId: number, page: number): boolean {
  return known.has(keyOf(docId, page));
}

/** Records what Rust reported for a page. */
export function setFileRotation(docId: number, page: number, degrees: number): void {
  known.set(keyOf(docId, page), degrees);
}

/** Forgets what is known about a document. */
export function forgetFileRotations(docId: number): void {
  for (const key of [...known.keys()]) if (key.startsWith(`${docId}:`)) known.delete(key);
}
