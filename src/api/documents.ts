import { MIN_RENDER_SCALE } from '../lib/zoom';
import { call } from './call';
import { toAppError, type AppError } from './errors';
import { parseFrame, type RenderFrame } from './frame';

/** Result of opening a document. `id` is opaque; the frontend never sees file paths. */
export interface DocumentInfo {
  id: number;
  pageCount: number;
  /**
   * The file's name for display (the status bar), made safe by the backend: no directory, no control or direction
   * characters, at most 255 characters. May be empty. Render it as text only.
   */
  displayName: string;
}

/** A rendered page: PNG bytes, their size and the scale they were actually rendered at (see `renderPage`). */
export interface RenderedPage extends RenderFrame {
  scale: number;
}

/**
 * The backend refuses frames above 4096 px per side (ADR-002 §6). Until pages render as tiles (M1) a high zoom on a
 * dense display can ask for more, so `renderPage` retries with a smaller scale. At most this many times, each time
 * with this factor, and never below the smallest scale the backend accepts.
 */
const MAX_LIMIT_RETRIES = 4;
const LIMIT_RETRY_FACTOR = 0.7;

/** A whole number from 0 up: the id and the page count are `u32` in the backend. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validates the backend's answer to opening a document. `null` if it is not a `DocumentInfo`; extra keys are dropped. */
export function parseDocumentInfo(value: unknown): DocumentInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, pageCount, displayName } = value as { id?: unknown; pageCount?: unknown; displayName?: unknown };
  if (!isCount(id) || !isCount(pageCount) || typeof displayName !== 'string') return null;
  return { id, pageCount, displayName };
}

/**
 * Shows the native open dialog. Resolves to `null` if the user cancels. An answer that does not have the documented shape
 * is an internal error, like a malformed frame: the viewer and the status bar rely on a name and a page count.
 */
export async function openDocumentDialog(): Promise<DocumentInfo | null> {
  const info = await call<unknown>('open_document_dialog');
  if (info === null) return null;
  const parsed = parseDocumentInfo(info);
  if (parsed === null) throw toAppError(null);
  return parsed;
}

function isFrameTooLarge(error: AppError): boolean {
  return error.code === 'limit_exceeded' && (error.params?.what === 'pixels' || error.params?.what === 'dimension');
}

/**
 * Renders one page to PNG. `pageId` is the page's position until pages can be reordered (M3). `scale` is device pixels
 * per PDF point (1 = 72 dpi); the backend accepts 0.1 to 8. The response is a validated frame (ADR-002 §6); the
 * returned `scale` is the one used, which is lower than requested only if the frame would have been too large.
 */
export async function renderPage(docId: number, pageId: number, scale: number): Promise<RenderedPage> {
  let attempt = scale;
  for (let retries = 0; ; retries += 1) {
    try {
      const body = await call<ArrayBuffer>('render_page', { docId, pageId, scale: attempt });
      const frame = parseFrame(new Uint8Array(body));
      if (frame === null) throw toAppError(null);
      return { ...frame, scale: attempt };
    } catch (error) {
      const next = attempt * LIMIT_RETRY_FACTOR;
      if (retries >= MAX_LIMIT_RETRIES || next < MIN_RENDER_SCALE || !isFrameTooLarge(toAppError(error))) throw error;
      attempt = next;
    }
  }
}

export function closeDocument(docId: number): Promise<void> {
  return call<void>('close_document', { docId });
}
