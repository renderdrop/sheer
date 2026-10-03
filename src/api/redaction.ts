import { applyCommand, type ChangeSet, type RedactSource } from './annotations';
import { call } from './call';
import { newChannel, requireJobId, type JobEvent, type JobId } from './jobs';
import type { Quad } from './wire';

/**
 * True redaction (ARCHITECTURE section 5, "Edit and protect"; ADR-047 section 3; src-tauri/src/commands/redact.rs). Marks are model
 * state: undoable, never written to a file. `applyRedactions` is a job that replaces each marked page by a raster with the marked
 * areas black; its result is one undo step (`done.changes`).
 */

/** The most marks one `markRedactions` command takes, and quads in one mark (`MAX_REDACT_MARKS_PER_COMMAND`, `MAX_REDACT_QUADS_PER_MARK`). */
export const MAX_REDACT_MARKS_PER_COMMAND = 10_000;
export const MAX_REDACT_QUADS_PER_MARK = 512;

/** The marks of one page in a `markRedactions` command (search hits become these). */
export interface RedactMarkSpec {
  pageId: number;
  quads: readonly Quad[];
  source: RedactSource;
}

/** The arguments of `apply_redactions`: `pages: null` is every page with marks. */
export interface RedactOptions {
  pages: readonly number[] | null;
  removeMetadata: boolean;
}

/** Marks areas as one undo step. Rejects with `limit_exceeded` (`marks`), `invalid_argument`, or `read_only` (`permission`). */
export function markRedactions(docId: number, marks: readonly RedactMarkSpec[]): Promise<ChangeSet> {
  return applyCommand(docId, { type: 'markRedactions', marks });
}

/**
 * Starts the redaction job (no dialog) and returns its id; `progress` events have `phase: 'redact'`, `done.changes` is the change set
 * of the step, `done.warnings` may hold `unsavedEditsDropped`. A cancel changes nothing (`cancelJob`).
 */
export async function applyRedactions(
  docId: number,
  opts: RedactOptions,
  onEvent: (event: JobEvent) => void,
): Promise<JobId> {
  return requireJobId(await call<unknown>('apply_redactions', { docId, opts, onEvent: newChannel(onEvent) }));
}
