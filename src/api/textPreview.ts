import { call } from './call';
import { toAppError } from './errors';
import { MAX_LINE_CHARS, type EditTextLine, type FallbackFace, type LineKey } from './textEdit';
import { isRecord, isUint, parseRect, type Rect } from './wire';

/**
 * The live preview of a line being edited (ADR-129 section 1, ARCHITECTURE section 13.5; src-tauri/src/commands/text_preview.rs). The
 * backend replays the page's edits and the draft, draws only the line's region and answers with a PNG. It never changes the document
 * and makes no undo step. Newer requests for the same page make older ones reject with `cancelled`, which callers ignore.
 */

/** Smallest and largest scale (pixels per point) the backend accepts (`TEXT_PREVIEW_MIN_SCALE`, `TEXT_PREVIEW_MAX_SCALE`). */
export const MIN_PREVIEW_SCALE = 0.5;
export const MAX_PREVIEW_SCALE = 8;

export interface TextPreviewRequest {
  docId: number;
  pageId: number;
  key: LineKey;
  /** The draft, at most 2 000 characters. */
  text: string;
  fit: EditTextLine['fit'];
  scope: EditTextLine['scope'];
  /** Counts the UI's keystrokes for this page; the backend drops work for an older one. */
  generation: number;
  /** Pixels per point, 0.5 to 8. The picture may be drawn at a lower scale (`pxPerPt` says). */
  scale: number;
}

/** In which substitute face the draft is drawn, and the characters of the draft that need it. */
export interface PreviewFallback {
  face: FallbackFace;
  chars: readonly string[];
}

export interface TextPreview {
  generation: number;
  /** The region of the picture in page space (points from the top left of the page's visible box, before the page's rotation). */
  rect: Rect;
  /** The scale of the picture. */
  pxPerPt: number;
  /** How far the draft reaches past the room it has, in points; 0 if it fits. */
  overflowPt: number;
  fallback: PreviewFallback | null;
  /** The PNG of the region (not rotated). */
  png: Uint8Array;
}

const FACES: ReadonlySet<unknown> = new Set<FallbackFace>(['sans', 'serif', 'mono']);
/** The metadata is a few hundred bytes; anything near this is not ours. */
const MAX_META_BYTES = 64 * 1024;

function parseFallback(value: unknown): PreviewFallback | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !FACES.has(value.face) || !Array.isArray(value.chars)) return undefined;
  if (value.chars.length > MAX_LINE_CHARS) return undefined;
  const chars: string[] = [];
  for (const item of value.chars as unknown[]) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 4) return undefined;
    chars.push(item);
  }
  return { face: value.face as FallbackFace, chars };
}

/** Parses the answer: a `u32` (little endian) length, that many bytes of JSON, then the PNG. `null` if it is not that. */
export function parseTextPreview(body: ArrayBuffer): TextPreview | null {
  if (body.byteLength < 4) return null;
  const length = new DataView(body).getUint32(0, true);
  if (length === 0 || length > MAX_META_BYTES || 4 + length >= body.byteLength) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, length)));
  } catch {
    return null;
  }
  if (!isRecord(meta)) return null;
  const { generation, pxPerPt, overflowPt } = meta;
  const rect = parseRect(meta.rect);
  const fallback = parseFallback(meta.fallback);
  if (rect === null || fallback === undefined || !isUint(generation, 0xffff_ffff)) return null;
  if (typeof pxPerPt !== 'number' || !Number.isFinite(pxPerPt) || pxPerPt <= 0) return null;
  if (typeof overflowPt !== 'number' || !Number.isFinite(overflowPt) || overflowPt < 0) return null;
  return { generation, rect, pxPerPt, overflowPt, fallback, png: new Uint8Array(body, 4 + length) };
}

/**
 * Renders the line `key` of a page with the draft text. Rejects with `cancelled` when a newer generation for the page was seen (ignore
 * it), `invalid_argument` (`lineKey`, `scale`), `limit_exceeded` (`text`, `pixels`), `read_only`, or `unsupported_feature`
 * (`textEdit`) like `applyCommand` with `editTextLine`. An answer of another shape is an internal error.
 */
export async function textEditPreview(request: TextPreviewRequest): Promise<TextPreview> {
  const body = await call<ArrayBuffer>('text_edit_preview', {
    docId: request.docId,
    pageId: request.pageId,
    key: request.key,
    text: request.text,
    fit: request.fit,
    scope: request.scope,
    generation: request.generation,
    scale: request.scale,
  });
  const preview = parseTextPreview(body);
  if (preview === null) throw toAppError(null);
  return preview;
}
