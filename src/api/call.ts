import { invoke } from '@tauri-apps/api/core';

import { toAppError } from './errors';

/** Calls a backend command. Whatever it rejects with becomes an `AppError`, so callers never see raw IPC errors. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toAppError(error);
  }
}
