import { parseChangeSet, type ChangeSet } from './annotations';
import { call } from './call';
import { parseDocumentInfo, type DocumentInfo } from './documents';
import { toAppError } from './errors';

/**
 * Saving (ARCHITECTURE section 5, src-tauri/src/commands/save.rs). The backend writes the file: no path crosses in either direction.
 * Save As shows the native dialog from Rust.
 */

/** What the user agreed to when a save asked for confirmation; today only a file that changed on disk can ask. */
export interface SaveAck {
  fileChanged?: boolean;
}

export type SaveMode = 'incremental' | 'full';

export interface SaveResult {
  rev: number;
  mode: SaveMode;
  /** The original was copied to the backup folder by this save. */
  backupCreated: boolean;
  /** The document as it is now (after Save As: another name, no longer the welcome document). */
  document: DocumentInfo;
  /** The annotations are `clean` now and the history is empty. */
  changes: ChangeSet;
}

function parseSaveResult(value: unknown): SaveResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const { rev, mode, backupCreated, document, changes } = value as Record<string, unknown>;
  const parsedDocument = parseDocumentInfo(document);
  const parsedChanges = parseChangeSet(changes);
  if (typeof rev !== 'number' || (mode !== 'incremental' && mode !== 'full') || typeof backupCreated !== 'boolean') {
    return null;
  }
  if (parsedDocument === null || parsedChanges === null) return null;
  return { rev, mode, backupCreated, document: parsedDocument, changes: parsedChanges };
}

/** Saves a document into the file it came from. Rejects with `read_only` for the welcome document, `needs_confirmation` when the file changed on disk. */
export async function saveDocument(docId: number, ack?: SaveAck): Promise<SaveResult> {
  const parsed = parseSaveResult(await call<unknown>('save_document', { docId, ack: ack ?? null }));
  if (parsed === null) throw toAppError(null);
  return parsed;
}

/** Asks where to save (a native dialog) and saves there; `null` if the user cancelled. */
export async function saveDocumentAs(docId: number, ack?: SaveAck): Promise<SaveResult | null> {
  const answer = await call<unknown>('save_document_as', { docId, opts: null, ack: ack ?? null });
  if (answer === null) return null;
  const parsed = parseSaveResult(answer);
  if (parsed === null) throw toAppError(null);
  return parsed;
}
