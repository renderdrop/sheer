import { create } from 'zustand';

import {
  DEFAULT_SETTINGS,
  appReady,
  getSettings,
  updateSettings,
  watchTransparency,
  type GlassMode,
  type Language,
  type Platform,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
} from '../api/app';
import { toAppError, type AppError } from '../api/errors';

/** Mirror of the Rust settings plus what the backend reports at startup (ARCHITECTURE §8). */
export interface SettingsState extends Settings {
  /** The OS "reduce transparency" flag from `app_ready` (macOS). CSS covers the other platforms. */
  osReducedTransparency: boolean;
  platform: Platform | null;
  version: string | null;
  /** `true` once `load` has finished, whether or not the backend answered. */
  loaded: boolean;
  /** The last failed backend call, for the UI to show. Cleared by the next success. */
  error: AppError | null;
  /** Reads `app_ready` and `get_settings`. Never rejects: on failure the defaults stay and `error` is set. */
  load: () => Promise<void>;
  /** Persists the change in the backend and applies what it answers. Never rejects; see `error`. */
  update: (patch: SettingsPatch) => Promise<void>;
  setGlass: (glass: GlassMode) => Promise<void>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  /** "system", "en" or "de". `bindLocaleToSettings` (src/i18n/bind.ts) turns it into the UI's locale. */
  setLanguage: (language: Language) => Promise<void>;
  /** The name put on new annotations (DESIGN 3.25); the backend refuses an empty or over-long one. */
  setAuthorName: (authorName: string) => Promise<void>;
}

/** Number of the newest `update` call. A slower, older answer must not overwrite a newer one. */
let latestUpdate = 0;

export const useSettings = create<SettingsState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  osReducedTransparency: false,
  platform: null,
  version: null,
  loaded: false,
  error: null,

  load: async () => {
    const [bootstrap, settings] = await Promise.allSettled([appReady(), getSettings()]);
    const failure = [bootstrap, settings].find((result) => result.status === 'rejected');
    set({
      ...(bootstrap.status === 'fulfilled'
        ? {
            osReducedTransparency: bootstrap.value.reducedTransparency,
            platform: bootstrap.value.platform,
            version: bootstrap.value.version,
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

  setGlass: (glass) => get().update({ glass }),
  setTheme: (theme) => get().update({ theme }),
  setLanguage: (language) => get().update({ language }),
  setAuthorName: (authorName) => get().update({ authorName }),
}));

/** `html[data-theme]`: absent for "system" so the OS decides. */
export function themeAttribute(state: Pick<Settings, 'theme'>): 'light' | 'dark' | null {
  return state.theme === 'system' ? null : state.theme;
}

/** `html[data-transparency="reduced"]`: the "Glass: Solid" setting or the OS flag. Absent otherwise. */
export function transparencyAttribute(state: Pick<SettingsState, 'glass' | 'osReducedTransparency'>): 'reduced' | null {
  return state.glass === 'solid' || state.osReducedTransparency ? 'reduced' : null;
}

/** The two methods of an element that the settings need. `document.documentElement` satisfies it. */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function setOrRemove(target: AttributeTarget, name: string, value: string | null): void {
  if (value === null) target.removeAttribute(name);
  else target.setAttribute(name, value);
}

/** Writes `data-theme` and `data-transparency` on `target` for the given state. */
export function applySettings(
  target: AttributeTarget,
  state: Pick<SettingsState, 'theme' | 'glass' | 'osReducedTransparency'>,
): void {
  setOrRemove(target, 'data-theme', themeAttribute(state));
  setOrRemove(target, 'data-transparency', transparencyAttribute(state));
}

/** Keeps the attributes on `target` (the `<html>` element) in step with the store. Returns the unsubscribe function. */
export function bindSettingsToRoot(
  target: AttributeTarget,
  store: Pick<typeof useSettings, 'getState' | 'subscribe'> = useSettings,
): () => void {
  applySettings(target, store.getState());
  return store.subscribe((state) => applySettings(target, state));
}

/** How long startup waits for the backend before it carries on with the defaults. */
export const SETTINGS_LOAD_TIMEOUT_MS = 3000;

const LOAD_TIMED_OUT: AppError = { code: 'internal', key: 'error.internal', retryable: true };

/**
 * Loads the settings in the background of an already rendered UI. Resolves when `load` has finished or after
 * `timeoutMs`, whichever comes first, and never rejects.
 *
 * If the backend does not answer in time, the defaults (follow the OS, glass on) stay in force, `loaded` becomes
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

/** The part of `watchTransparency` (src/api/app.ts) that is used here. */
export type WatchFunction = (onChange: (reduced: boolean) => void) => Promise<void>;

/**
 * Keeps `osReducedTransparency` in step with the OS while the app runs: the backend sends the flag over a channel this
 * call opens (macOS: when the window regains focus after System Settings; see `watch_transparency`). Resolves once the
 * channel is open. Never rejects: outside Tauri, or if the backend refuses, the flag simply stays as `load` read it.
 */
export async function watchOsTransparency(
  store: Pick<typeof useSettings, 'setState'> = useSettings,
  watch: WatchFunction = watchTransparency,
): Promise<void> {
  try {
    await watch((reduced) => store.setState({ osReducedTransparency: reduced }));
  } catch {
    // The flag keeps the value `load` read from `app_ready`.
  }
}
