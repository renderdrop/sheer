import { MIN_RENDER_SCALE } from '../lib/zoom';
import { call } from './call';
import { toAppError, type AppError } from './errors';
import { parseFrame, type RenderFrame } from './frame';

/** Result of opening a document. `id` is opaque; the frontend never sees file paths. */
export interface DocumentInfo {
  id: number;
  pageCount: number;
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

/** Shows the native open dialog. Resolves to `null` if the user cancels. */
export function openDocumentDialog(): Promise<DocumentInfo | null> {
  return call<DocumentInfo | null>('open_document_dialog');
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
