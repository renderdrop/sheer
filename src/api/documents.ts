import { call } from './call';
import { toAppError, type AppError } from './errors';
import type { Permission } from './protection';
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
  /**
   * What the file's permissions still allow when it was opened with the open password of a restricted file (ADR-047); `null`: not
   * encrypted, or opened with owner rights. The backend always sends it; optional here like `flags`. Without `edit` the backend refuses edits.
   */
  permissions?: readonly Permission[] | null;
}

/** Where a document comes from (src-tauri/src/documents/mod.rs, `DocKind`): `welcome` is the bundled tour sample (ADR-023), `recovered` is a crash-recovery snapshot (ADR-053), `user` is every file the user opened. */
export const DOC_KINDS = ['user', 'welcome', 'recovered'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

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
  /** `welcome` for the tour's sample, which is read-only. Optional in the type like `flags`; the backend always sends it. */
  kind?: DocKind;
}

/** A whole number from 0 up to `max`: the id and the page count are `u32` in the backend. */
function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

const PERMISSIONS: ReadonlySet<unknown> = new Set<Permission>(['print', 'copy', 'edit']);

/** Validates document flags; `null` if they are not four booleans (and, if present, a list of permissions or `null`). Extra keys are dropped. */
export function parseDocFlags(value: unknown): DocFlags | null {
  if (typeof value !== 'object' || value === null) return null;
  const { encrypted, xfa, hasForms, signed, permissions } = value as Record<string, unknown>;
  if (
    typeof encrypted !== 'boolean' ||
    typeof xfa !== 'boolean' ||
    typeof hasForms !== 'boolean' ||
    typeof signed !== 'boolean'
  ) {
    return null;
  }
  if (permissions === undefined) return { encrypted, xfa, hasForms, signed };
  if (permissions === null) return { encrypted, xfa, hasForms, signed, permissions: null };
  if (
    !Array.isArray(permissions) ||
    permissions.length > 3 ||
    !(permissions as unknown[]).every((p) => PERMISSIONS.has(p))
  ) {
    return null;
  }
  return { encrypted, xfa, hasForms, signed, permissions: permissions as Permission[] };
}

/**
 * Validates the backend's answer to opening a document. `null` if it is not a `DocumentInfo`; extra keys are dropped. `flags` are
 * kept if they are there and are four booleans, and a document whose flags are there and are anything else is not one.
 */
export function parseDocumentInfo(value: unknown): DocumentInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, pageCount, displayName, flags, kind } = value as {
    id?: unknown;
    pageCount?: unknown;
    displayName?: unknown;
    flags?: unknown;
    kind?: unknown;
  };
  if (!isCount(id) || !isCount(pageCount, MAX_PAGES) || typeof displayName !== 'string') return null;
  const info: DocumentInfo = { id, pageCount, displayName };
  if (kind !== undefined) {
    // A kind that is there and unknown is not a document of ours.
    if (!DOC_KINDS.includes(kind as DocKind)) return null;
    info.kind = kind as DocKind;
  }
  if (flags === undefined) return info;
  const parsed = parseDocFlags(flags);
  if (parsed === null) return null;
  info.flags = parsed;
  return info;
}

/**
 * How opening one file went: `opened` with the document (also for a file that was open already: it comes back with the id it
 * has), `needsPassword` for an encrypted file (it waits in the backend under `id` for `unlockDocument`, or for `closeDocument`
 * when the user cancels; ADR-026), or `openFailed` with the error that a rejected command would have carried. None names the
 * file or its path. The open dialog answers with a list of these, and the backend pushes them for files dropped on the window or
 * opened by the OS (`subscribeApp` in `app.ts`), in the same shapes.
 */
export type OpenOutcome =
  | { type: 'opened'; document: DocumentInfo }
  | { type: 'needsPassword'; id: number; displayName: string }
  | { type: 'openFailed'; error: AppError };

/** Validates one open outcome from the backend. `null` if it is not one; extra keys are dropped. */
export function parseOpenOutcome(value: unknown): OpenOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, document, id, displayName } = value as {
    type?: unknown;
    document?: unknown;
    id?: unknown;
    displayName?: unknown;
  };
  if (type === 'opened') {
    const parsed = parseDocumentInfo(document);
    return parsed === null ? null : { type, document: parsed };
  }
  if (type === 'needsPassword') {
    return isCount(id) && typeof displayName === 'string' ? { type, id, displayName } : null;
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

/**
 * Opens the bundled welcome document (ADR-023) in the language of the interface: the backend finds the file, nothing path-like
 * crosses. Resolves to how it went (`opened` with `kind: "welcome"`, or `openFailed`); an answer that is not an open outcome is an
 * internal error. A welcome document that is open already is closed by the backend first.
 */
export async function openWelcomeDocument(): Promise<OpenOutcome> {
  const parsed = parseOpenOutcome(await call<unknown>('open_welcome_document'));
  if (parsed === null) throw toAppError(null);
  return parsed;
}

/** Releases a document. With changes that are not saved the backend rejects with `unsaved_changes` unless `discard` is true. */
export function closeDocument(docId: number, discard = false): Promise<void> {
  return call<void>('close_document', discard ? { docId, discard } : { docId });
}

/** The longest password the backend takes, in bytes (`limits::MAX_PASSWORD_BYTES`). */
export const MAX_PASSWORD_BYTES = 1024;

/**
 * Gives the backend the password of a document that waits for it (`needsPassword`) and resolves to the document once it is open.
 * The password crosses once per attempt and is not kept: not here, not in a store. A wrong password rejects with
 * `password_required` (after the third wrong one the backend makes each try wait a second); any other rejection means the
 * document is gone. An answer that is not a `DocumentInfo` is an internal error.
 */
export async function unlockDocument(docId: number, password: string): Promise<DocumentInfo> {
  const parsed = parseDocumentInfo(await call<unknown>('unlock_document', { docId, password }));
  if (parsed === null) throw toAppError(null);
  return parsed;
}
