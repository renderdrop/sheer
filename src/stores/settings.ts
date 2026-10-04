import { create } from 'zustand';

import {
  DEFAULT_SETTINGS,
  appReady,
  getSettings,
  updateSettings,
  type Language,
  type Platform,
  type Settings,
  type SettingsPatch,
} from '../api/app';
import { toAppError, type AppError } from '../api/errors';

/** Mirror of the Rust settings plus what the backend reports at startup (ARCHITECTURE §8). */
export interface SettingsState extends Settings {
  platform: Platform | null;
  version: string | null;
  /** The OS account name, offered by the author prompt as a suggestion only (ADR-034). */
  authorSuggestion: string;
  /** `true` once `load` has finished, whether or not the backend answered. */
  loaded: boolean;
  /** The last failed backend call, for the UI to show. Cleared by the next success. */
  error: AppError | null;
  /** Reads `app_ready` and `get_settings`. Never rejects: on failure the defaults stay and `error` is set. */
  load: () => Promise<void>;
  /** Persists the change in the backend and applies what it answers. Never rejects; see `error`. */
  update: (patch: SettingsPatch) => Promise<void>;
  /** "system", "en" or "de". `bindLocaleToSettings` (src/i18n/bind.ts) turns it into the UI's locale. */
  setLanguage: (language: Language) => Promise<void>;
  /** The name put on new annotations (DESIGN 3.25); empty is allowed (no author), the backend refuses an over-long one. */
  setAuthorName: (authorName: string) => Promise<void>;
  /** Ends the one-time author prompt (ADR-034): stores `name` when given (an empty or no name keeps the author empty) and sets `authorPrompt` to done. */
  finishAuthorPrompt: (name: string | null) => Promise<void>;
}

/** Number of the newest `update` call. A slower, older answer must not overwrite a newer one. */
let latestUpdate = 0;

export const useSettings = create<SettingsState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  platform: null,
  version: null,
  authorSuggestion: '',
  loaded: false,
  error: null,

  load: async () => {
    const [bootstrap, settings] = await Promise.allSettled([appReady(), getSettings()]);
    const failure = [bootstrap, settings].find((result) => result.status === 'rejected');
    set({
      ...(bootstrap.status === 'fulfilled'
        ? {
            platform: bootstrap.value.platform,
            version: bootstrap.value.version,
            authorSuggestion: bootstrap.value.authorSuggestion,
          }
        : {}),
      ...(settings.status === 'fulfilled' ? settings.value : {}),
      loaded: true,
      error: failure === undefined ? null : toAppError(failure.reason),
    });
  },

  update: async (patch) => {
    const ticket = ++latestUpdate;
    try {
      const settings = await updateSettings(patch);
      if (ticket === latestUpdate) set({ ...settings, error: null });
    } catch (caught) {
      if (ticket === latestUpdate) set({ error: toAppError(caught) });
    }
  },

  setLanguage: (language) => get().update({ language }),
  setAuthorName: (authorName) => get().update({ authorName }),
  finishAuthorPrompt: (name) =>
    get().update(name === null || name === '' ? { authorPrompt: 'done' } : { authorName: name, authorPrompt: 'done' }),
}));

/** The method of an element that `bindLocaleToSettings` needs. `document.documentElement` satisfies it. */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
}

/** How long startup waits for the backend before it carries on with the defaults. */
export const SETTINGS_LOAD_TIMEOUT_MS = 3000;

const LOAD_TIMED_OUT: AppError = { code: 'internal', key: 'error.internal', retryable: true };

/**
 * Loads the settings in the background of an already rendered UI. Resolves when `load` has finished or after
 * `timeoutMs`, whichever comes first, and never rejects.
 *
 * If the backend does not answer in time, the defaults stay in force, `loaded` becomes
 * `true` and `error` says so. The call that is still pending is not cancelled: if it answers later, its settings are
 * applied then, like any other `load`.
 */
export async function loadSettings(
  timeoutMs: number = SETTINGS_LOAD_TIMEOUT_MS,
  store: Pick<typeof useSettings, 'getState' | 'setState'> = useSettings,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const finished = store
    .getState()
    .load()
    .then(() => 'loaded' as const);
  const outcome = await Promise.race([finished, timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout' && !store.getState().loaded) {
    store.setState({ loaded: true, error: LOAD_TIMED_OUT });
  }
}
