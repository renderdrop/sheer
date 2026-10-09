import { call } from './call';
import { AUTOSAVE_STATUSES, parseOpenOutcome, type AutosaveStatus, type OpenOutcome } from './documents';
import { toAppError } from './errors';

/*
 * Crash recovery (docs/ARCHITECTURE.md section 5, "Ship (M7)", ADR-053 section 2; commands/recovery.rs). Every record is named by a
 * session-scoped id: the UI never learns a path, only the document's name.
 */

/** Names one recovery record for this session; not stable across runs. */
export type RecoveryId = number;

/** Whether the file the document came from is still what it was. */
export const ORIGIN_STATES = ['unchanged', 'changed', 'missing'] as const;
export type OriginState = (typeof ORIGIN_STATES)[number];

export interface RecoveryEntry {
  id: RecoveryId;
  displayName: string;
  /** ISO 8601. */
  savedAt: string;
  pageCount: number;
  original: OriginState;
  /** Not shown by an earlier start (the persisted ledger); the banner needs at least one. Absent means fresh. */
  fresh?: boolean;
}

export { AUTOSAVE_STATUSES, type AutosaveStatus };

/** The most records one answer holds: a session leaves at most one per open document. */
const MAX_ENTRIES = 256;
const MAX_TEXT = 512;

const count = (value: unknown, max = 0xffff_ffff): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** One entry from an answer; `null` if it is not one. Extra keys are dropped. */
export function parseRecoveryEntry(value: unknown): RecoveryEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, displayName, savedAt, pageCount, original, fresh } = value as Record<string, unknown>;
  if (
    !count(id) ||
    typeof displayName !== 'string' ||
    displayName.length > MAX_TEXT ||
    typeof savedAt !== 'string' ||
    savedAt.length > 64 ||
    Number.isNaN(Date.parse(savedAt)) ||
    !count(pageCount) ||
    !ORIGIN_STATES.includes(original as OriginState)
  ) {
    return null;
  }
  return {
    id,
    displayName,
    savedAt,
    pageCount,
    original: original as OriginState,
    ...(typeof fresh === 'boolean' ? { fresh } : {}),
  };
}

/** The documents a crashed session left behind, newest first. Empty when there are none. */
export async function listRecoveries(): Promise<RecoveryEntry[]> {
  const answer = await call<unknown>('list_recoveries');
  if (!Array.isArray(answer) || answer.length > MAX_ENTRIES) throw toAppError(null);
  const entries: RecoveryEntry[] = [];
  for (const item of answer as unknown[]) {
    const entry = parseRecoveryEntry(item);
    if (entry === null) throw toAppError(null);
    entries.push(entry);
  }
  return entries;
}

/**
 * Opens record `id` as a recovered document (`kind: "recovered"`): Save acts as Save As. Resolves to how the open went, like a file
 * from the dialog; an unknown id rejects with `not_found` `recovery`.
 */
export async function restoreRecovery(id: RecoveryId): Promise<OpenOutcome> {
  const outcome = parseOpenOutcome(await call<unknown>('restore_recovery', { id }));
  if (outcome === null) throw toAppError(null);
  return outcome;
}

/** Discards one record at once: it is never listed again. `undoDiscardRecovery` takes it back until the app exits (F21.2). */
export function discardRecovery(id: RecoveryId): Promise<void> {
  return call<void>('discard_recovery', { id });
}

/** Takes a discard back (the Undo of the toast): the record is listed again. Rejects with `not_found` when it is gone. */
export function undoDiscardRecovery(id: RecoveryId): Promise<void> {
  return call<void>('undo_discard_recovery', { id });
}

/** Deletes every record; resolves to how many there were. */
export async function discardAllRecoveries(): Promise<number> {
  const removed = await call<unknown>('discard_all_recoveries');
  if (!count(removed)) throw toAppError(null);
  return removed;
}
