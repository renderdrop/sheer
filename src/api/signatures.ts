import { call } from './call';
import { toAppError } from './errors';
import { parseFrame, type RenderFrame } from './frame';
import type { LibraryItem, SignatureRole } from './library';
import { isRecord, isUint, parsePoint, type Point } from './wire';
import { MAX_SIGNATURE_ASPECT, MIN_SIGNATURE_ASPECT } from './annotations';

/**
 * Making and placing signatures (src-tauri/src/commands/signatures.rs, ADR-041 sections 5, 6 and 8). The art never carries file
 * bytes or paths: vector art is polygons, raster art is fetched as a frame. The saved library is `./library`.
 */

/** Polygons of vector art: 1 000 units high, y down, filled with the nonzero rule. */
export const MAX_SIGNATURE_POLYGONS = 1_024;
export const MAX_SIGNATURE_POINTS = 100_000;
/** Longest typed signature, in characters. */
export const MAX_TYPED_CHARS = 64;
/** Range of `maxPx` of a preview. */
export const MIN_PREVIEW_PX = 16;
export const MAX_PREVIEW_PX = 1024;

export type TypedFont = 'homemadeApple';

export type SignatureArt =
  | { type: 'vector'; w: number; h: number; paths: readonly (readonly Point[])[] }
  | { type: 'raster'; w: number; h: number };

export interface SignatureDraft {
  id: number;
  role: SignatureRole;
  art: SignatureArt;
}

/** Where art is: a draft, a library entry (32 lowercase hex), or an asset of a document. */
export type SignatureRef =
  { type: 'draft'; id: number } | { type: 'library'; id: string } | { type: 'asset'; docId: number; assetId: number };

export interface AssetInfo {
  assetId: number;
  /** Width over height. */
  aspect: number;
  art: SignatureArt;
}

const isRole = (value: unknown): value is SignatureRole => value === 'signature' || value === 'initials';
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function parseSignatureArt(value: unknown): SignatureArt | null {
  if (!isRecord(value) || !isSize(value.w) || !isSize(value.h)) return null;
  const { w, h } = value;
  if (value.type === 'raster') return Number.isInteger(w) && Number.isInteger(h) ? { type: 'raster', w, h } : null;
  if (value.type !== 'vector' || !Array.isArray(value.paths) || value.paths.length > MAX_SIGNATURE_POLYGONS)
    return null;
  let total = 0;
  const paths: Point[][] = [];
  for (const path of value.paths as unknown[]) {
    if (!Array.isArray(path)) return null;
    total += path.length;
    if (total > MAX_SIGNATURE_POINTS) return null;
    const points: Point[] = [];
    for (const item of path as unknown[]) {
      const point = parsePoint(item);
      if (point === null) return null;
      points.push(point);
    }
    paths.push(points);
  }
  return { type: 'vector', w, h, paths };
}

export function parseSignatureDraft(value: unknown): SignatureDraft | null {
  if (!isRecord(value)) return null;
  const art = parseSignatureArt(value.art);
  return isUint(value.id) && isRole(value.role) && art !== null ? { id: value.id, role: value.role, art } : null;
}

export function parseAssetInfo(value: unknown): AssetInfo | null {
  if (!isRecord(value)) return null;
  const art = parseSignatureArt(value.art);
  const { assetId, aspect } = value;
  return isUint(assetId) &&
    typeof aspect === 'number' &&
    aspect >= MIN_SIGNATURE_ASPECT &&
    aspect <= MAX_SIGNATURE_ASPECT &&
    art !== null
    ? { assetId, aspect, art }
    : null;
}

function need<T>(value: T | null): T {
  if (value === null) throw toAppError(null);
  return value;
}

/** A drawn signature from perfect-freehand outline polygons in pad pixels; the backend trims, scales and simplifies them. */
export async function createDrawnSignature(
  role: SignatureRole,
  outlines: readonly (readonly Point[])[],
): Promise<SignatureDraft> {
  return need(parseSignatureDraft(await call<unknown>('create_drawn_signature', { role, outlines })));
}

/** A typed signature (1 to 64 characters). Rejects with `invalid_argument` (`glyph`) for a character the font lacks. */
export async function createTypedSignature(
  role: SignatureRole,
  text: string,
  font: TypedFont = 'homemadeApple',
): Promise<SignatureDraft> {
  return need(parseSignatureDraft(await call<unknown>('create_typed_signature', { role, text, font })));
}

/** Asks for a PNG or JPEG in a native dialog; `null` if it was cancelled. */
export async function importSignatureImage(
  role: SignatureRole,
  removeBackground: boolean,
): Promise<SignatureDraft | null> {
  const answer = await call<unknown>('import_signature_image', { role, removeBackground });
  return answer === null ? null : need(parseSignatureDraft(answer));
}

/** Saves a draft in the library without its art crossing IPC; resolves with the new entry. */
export function saveDraftSignature(draftId: number, name: string): Promise<LibraryItem> {
  return call<LibraryItem>('save_draft_signature', { draftId, name });
}

/** A PNG frame of raster art, at most `maxPx` (16 to 1024) on its long side. */
export async function getSignaturePreview(art: SignatureRef, maxPx: number): Promise<RenderFrame> {
  const body = await call<ArrayBuffer>('get_signature_preview', { art, maxPx });
  return need(parseFrame(new Uint8Array(body)));
}

/** Copies art into the document's assets; then create a `signature` annotation with `assetId` and `aspect`. */
export async function useSignature(docId: number, art: SignatureRef): Promise<AssetInfo> {
  return need(parseAssetInfo(await call<unknown>('use_signature', { docId, art })));
}
