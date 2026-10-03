import { call } from './call';
import { toAppError } from './errors';
import { parseOpenOutcome, type OpenOutcome } from './documents';

/** A whole number from 0 up to `max`. */
function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * A recent file as the UI may know it (src-tauri/src/storage/recents.rs): the id is good for this run only, and there is no path
 * and no folder. `lastOpened` is in seconds since 1970 (0 when unknown); `missing` is true when the file is not there now.
 */
export interface RecentEntry {
  id: number;
  displayName: string;
  lastOpened: number;
  missing: boolean;
}

/** The most recent files the backend keeps and lists. */
export const MAX_RECENTS = 50;

/** Validates one recent entry; `null` if it is not one. Extra keys are dropped. */
export function parseRecentEntry(value: unknown): RecentEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, displayName, lastOpened, missing } = value as Record<string, unknown>;
  if (
    !isCount(id, 0xffffffff) ||
    typeof displayName !== 'string' ||
    !isCount(lastOpened) ||
    typeof missing !== 'boolean'
  ) {
    return null;
  }
  return { id, displayName, lastOpened, missing };
}

/** The recent files, newest first. An answer that is not a list of at most 50 entries is an internal error. */
export async function listRecents(): Promise<RecentEntry[]> {
  const answer = await call<unknown>('list_recents');
  if (!Array.isArray(answer) || answer.length > MAX_RECENTS) throw toAppError(null);
  return (answer as unknown[]).map((item) => {
    const parsed = parseRecentEntry(item);
    if (parsed === null) throw toAppError(null);
    return parsed;
  });
}

/** Takes one entry off the list of recent files (the file stays where it is). */
export function removeRecent(recentId: number): Promise<void> {
  return call<void>('remove_recent', { recentId });
}

/**
 * Opens a recent file by its id. Resolves to how it went like the dialog does for one file (`opened`, `needsPassword` or
 * `openFailed`; a file that is gone is `openFailed` with `io_not_found`); rejects with `not_found` for an id that is not listed.
 */
export async function openRecent(recentId: number): Promise<OpenOutcome> {
  const parsed = parseOpenOutcome(await call<unknown>('open_recent', { recentId }));
  if (parsed === null) throw toAppError(null);
  return parsed;
}

/** Tells the macOS menu bar whether a document is open, so it greys the commands that need one. Rejects like any command. */
export function setMenuState(hasDocument: boolean): Promise<void> {
  return call<void>('set_menu_state', { hasDocument });
}
