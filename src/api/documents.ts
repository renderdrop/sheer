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
 * How opening one file went: `opened` with the document (also for a file that was open already: it comes back with the id it
 * has), or `openFailed` with the error that a rejected command would have carried. Neither names the file or its path. The
 * open dialog answers with a list of these, and the backend pushes them for files dropped on the window or opened by the OS
 * (`subscribeApp` in `app.ts`), in the same shapes.
 */
export type OpenOutcome = { type: 'opened'; document: DocumentInfo } | { type: 'openFailed'; error: AppError };

/** Validates one open outcome from the backend. `null` if it is not one; extra keys are dropped. */
export function parseOpenOutcome(value: unknown): OpenOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, document } = value as { type?: unknown; document?: unknown };
  if (type === 'opened') {
    const parsed = parseDocumentInfo(document);
    return parsed === null ? null : { type, document: parsed };
  }
  // The error sits flat in the message, next to `type`: `toAppError` reads the fields it knows and nothing else.
  if (type === 'openFailed') return { type, error: toAppError(value) };
  return null;
}

/**
 * The most outcomes one answer holds: at most 32 files are opened per request and one more entry says that the rest were left
 * out (src-tauri/src/limits.rs, `MAX_OPEN_BATCH`).
 */
const MAX_OUTCOMES = 33;

/**
 * Shows the native open dialog, where several files can be chosen, and resolves to how each went, in the order the dialog gave
 * them; empty if the user cancels. An answer that does not have the documented shape is an internal error, like a malformed
 * frame: the viewer and the status bar rely on a name and a page count.
 */
export async function openDocumentDialog(): Promise<OpenOutcome[]> {
  const answer = await call<unknown>('open_document_dialog');
  if (!Array.isArray(answer) || answer.length > MAX_OUTCOMES) throw toAppError(null);
  const outcomes: OpenOutcome[] = [];
  for (const item of answer as unknown[]) {
    const parsed = parseOpenOutcome(item);
    if (parsed === null) throw toAppError(null);
    outcomes.push(parsed);
  }
  return outcomes;
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
