import { Channel } from '@tauri-apps/api/core';

import { call } from './call';
import { ERROR_CODES, toAppError, type AppError, type ErrorCode } from './errors';

/*
 * Updates (docs/ARCHITECTURE.md section 5, "Ship (M7)", ADR-053 section 3; commands/update.rs). The backend makes every request;
 * the UI only asks and shows. `check_for_update` rejects with `unsupported_feature` while the signing key is the placeholder.
 */

export interface UpdateInfo {
  version: string;
  date: string | null;
  /** Plain text, at most 4 KiB, control and bidirectional characters stripped by the backend. */
  notes: string;
}

export type UpdateEvent =
  | { kind: 'progress'; downloaded: number; total: number | null }
  /** Downloaded and verified; the install happens on quit. */
  | { kind: 'verified' }
  /** A bad signature deletes the download. */
  | { kind: 'failed'; code: ErrorCode };

/** Longest version string `skipUpdateVersion` takes (`limits::UPDATE_VERSION_MAX_CHARS`). */
export const UPDATE_VERSION_MAX = 32;
const NOTES_MAX_BYTES = 4 * 1024;

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** An `UpdateInfo` from an answer or a push; `null` if it is not one. Extra keys are dropped. */
export function parseUpdateInfo(value: unknown): UpdateInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, date, notes } = value as Record<string, unknown>;
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    version.length > UPDATE_VERSION_MAX ||
    !(date === null || (typeof date === 'string' && date.length <= 64)) ||
    typeof notes !== 'string' ||
    new TextEncoder().encode(notes).length > NOTES_MAX_BYTES
  ) {
    return null;
  }
  return { version, date, notes };
}

/** One message of the download channel; `null` if it is not one. */
export function parseUpdateEvent(value: unknown): UpdateEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, downloaded, total, code } = value as Record<string, unknown>;
  if (kind === 'progress') {
    return whole(downloaded) && (total === null || whole(total)) ? { kind, downloaded, total } : null;
  }
  if (kind === 'verified') return { kind };
  if (kind === 'failed') {
    return (ERROR_CODES as readonly unknown[]).includes(code) ? { kind, code: code as ErrorCode } : null;
  }
  return null;
}

/** Looks for a newer version (one request, to the fixed endpoint). Resolves to `null` when this is the newest. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const answer = await call<unknown>('check_for_update');
  if (answer === null) return null;
  const info = parseUpdateInfo(answer);
  if (info === null) throw toAppError(null);
  return info;
}

/** Downloads and verifies the update; progress and the result come on `onEvent`. Resolves once the download ended. */
export function downloadUpdate(onEvent: (event: UpdateEvent) => void): Promise<void> {
  const channel = new Channel<unknown>((message) => {
    const event = parseUpdateEvent(message);
    if (event !== null) onEvent(event);
  });
  return call<void>('download_update', { onEvent: channel });
}

/** Installs the downloaded update when the app quits, after every dirty document has been dealt with. */
export function installUpdateOnQuit(): Promise<void> {
  return call<void>('install_update_on_quit');
}

/** Does not offer `version` again. Rejects with `invalid_argument` `updateVersion` for a string that is not a version. */
export function skipUpdateVersion(version: string): Promise<void> {
  return call<void>('skip_update_version', { version });
}

/** The signing key is still the placeholder, so the updater cannot run and the Updates setting stays hidden (BLOCKERS B-005). */
export function isUpdaterUnconfigured(error: AppError): boolean {
  return error.code === 'unsupported_feature' && error.params?.what === 'updater_unconfigured';
}
