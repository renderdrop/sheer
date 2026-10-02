import { create } from 'zustand';

import {
  DEFAULT_SETTINGS,
  appReady,
  getSettings,
  updateSettings,
  type GlassMode,
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
