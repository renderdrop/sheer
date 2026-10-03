import { call } from './call';
import { toAppError, type AppError } from './errors';
import { MAX_PAGES } from './render';

/**
 * What PDFium says about a document, as far as it can tell (src-tauri/src/documents/mod.rs, `DocFlags`): best effort, nothing here
 * is a security promise. Read once, when the document is loaded.
 */
export interface DocFlags {
  /** The file has a security handler (a password or permissions). */
  encrypted: boolean;
  /** The form is an XFA form. This build of PDFium has no XFA support: such a document shows its fallback page, or none. */
  xfa: boolean;
  /** The document has an interactive form (AcroForm or XFA). */
  hasForms: boolean;
  /** The document has a digital signature field that is signed. Whether the signature is valid is not checked. */
  signed: boolean;
}

/** Result of opening a document. `id` is opaque; the frontend never sees file paths. */
export interface DocumentInfo {
  id: number;
  pageCount: number;
  /**
   * The file's name for display (the status bar), made safe by the backend: no directory, no control or direction
   * characters, at most 255 characters. May be empty. Render it as text only.
   */
  displayName: string;
  /**
   * What PDFium found in the document (encrypted, XFA, form, signed). The backend always sends it; it is optional in the type so that
   * a document value built without it (a test, a stub) is still a `DocumentInfo`, and a `DocumentInfo` that has it is complete.
   */
  flags?: DocFlags;
}

/** A whole number from 0 up to `max`: the id and the page count are `u32` in the backend. */
function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Validates document flags; `null` if they are not four booleans. Extra keys are dropped. */
export function parseDocFlags(value: unknown): DocFlags | null {
  if (typeof value !== 'object' || value === null) return null;
  const { encrypted, xfa, hasForms, signed } = value as Record<string, unknown>;
  if (
    typeof encrypted !== 'boolean' ||
    typeof xfa !== 'boolean' ||
    typeof hasForms !== 'boolean' ||
    typeof signed !== 'boolean'
  ) {
    return null;
  }
  return { encrypted, xfa, hasForms, signed };
}

/**
 * Validates the backend's answer to opening a document. `null` if it is not a `DocumentInfo`; extra keys are dropped. `flags` are
 * kept if they are there and are four booleans, and a document whose flags are there and are anything else is not one.
 */
export function parseDocumentInfo(value: unknown): DocumentInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, pageCount, displayName, flags } = value as {
    id?: unknown;
    pageCount?: unknown;
    displayName?: unknown;
    flags?: unknown;
  };
  if (!isCount(id) || !isCount(pageCount, MAX_PAGES) || typeof displayName !== 'string') return null;
  if (flags === undefined) return { id, pageCount, displayName };
  const parsed = parseDocFlags(flags);
  return parsed === null ? null : { id, pageCount, displayName, flags: parsed };
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

export function closeDocument(docId: number): Promise<void> {
  return call<void>('close_document', { docId });
}
