import { call } from './call';
import { toAppError } from './errors';
import { parseOpenOutcome, type OpenOutcome } from './documents';
import { parseFrame, type RenderFrame } from './frame';

/** A whole number from 0 up to `max`. */
function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * A recent file as the UI may know it (src-tauri/src/storage/recents.rs): the id is good for this run only, and there is no path
 * and only the name of the parent folder. `lastOpened` is in seconds since 1970 (0 when unknown); `missing` is true when the file is not there now.
 */
export interface RecentEntry {
  id: number;
  displayName: string;
  /** The parent folder's name (its last segment), never a path; empty when there is none. */
  folder: string;
  lastOpened: number;
  missing: boolean;
  /** Marked by the user ("Markiert"); starred entries are never pushed off the list by the cap. */
  starred: boolean;
}

/** The most recent files the backend keeps and lists. */
export const MAX_RECENTS = 50;

/** Validates one recent entry; `null` if it is not one. Extra keys are dropped. */
export function parseRecentEntry(value: unknown): RecentEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, displayName, folder, lastOpened, missing, starred } = value as Record<string, unknown>;
  if (
    !isCount(id, 0xffffffff) ||
    typeof displayName !== 'string' ||
    typeof folder !== 'string' ||
    !isCount(lastOpened) ||
    typeof missing !== 'boolean' ||
    typeof starred !== 'boolean'
  ) {
    return null;
  }
  return { id, displayName, folder, lastOpened, missing, starred };
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

/** Puts a removed entry back in its place; resolves to whether it was (false: it was not removed in this run, or is listed again). */
export function restoreRecent(recentId: number): Promise<boolean> {
  return call<boolean>('restore_recent', { recentId }).then((done) => done === true);
}

/**
 * Lets the user find a recent file that moved: the backend shows the file dialog and points the entry to the file chosen (the path
 * never reaches the UI). Resolves to whether the entry was changed (false: cancelled); rejects with `not_found` for an id that is not listed.
 */
export function locateRecent(recentId: number): Promise<boolean> {
  return call<boolean>('locate_recent', { recentId }).then((done) => done === true);
}

/** Marks a recent file as a favourite or takes the mark off. Rejects with `not_found` for an id that is not listed. */
export function setRecentStarred(recentId: number, starred: boolean): Promise<void> {
  return call<void>('set_recent_starred', { recentId, starred });
}

/**
 * Shows a recent file in the OS file manager (Explorer / Finder) with the file selected; the path never reaches the UI. Rejects with
 * `not_found` for an id that is not listed or a file that is gone.
 */
export function revealRecent(recentId: number): Promise<void> {
  return call<void>('reveal_recent', { recentId });
}

/**
 * The preview of a recent file: its first page as a PNG frame of at most 64 x 80 px, made by the backend after the file opened, and when it was closed or
 * saved (never for a file with a password). Rejects with `not_found` when there is none (the row shows its placeholder).
 */
export async function getRecentThumbnail(recentId: number): Promise<RenderFrame> {
  const body = await call<ArrayBuffer>('get_recent_thumbnail', { recentId });
  const frame = parseFrame(new Uint8Array(body));
  if (frame === null) throw toAppError(null);
  return frame;
}

/** Tells the macOS menu bar whether a document is open, so it greys the commands that need one. Rejects like any command. */
export function setMenuState(hasDocument: boolean): Promise<void> {
  return call<void>('set_menu_state', { hasDocument });
}
