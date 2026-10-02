import { Channel } from '@tauri-apps/api/core';

import { call } from './call';
import { toAppError } from './errors';

/** Wire names of the backend's `Platform` (src-tauri/src/platform/mod.rs). */
export const PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Wire names of the backend's `GlassMode` and `ThemeMode` (src-tauri/src/storage/settings.rs). Keep in sync. */
export const GLASS_MODES = ['auto', 'solid'] as const;
export type GlassMode = (typeof GLASS_MODES)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** The persisted settings. "Glass: Solid" forces opaque surfaces; the theme overrides the OS. */
export interface Settings {
  glass: GlassMode;
  theme: ThemeMode;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { glass: 'auto', theme: 'system' };

/** A partial update. The backend rejects unknown keys and values with `invalid_argument`. */
export type SettingsPatch = Partial<Settings>;

/** What the backend reports at startup (`app_ready`). */
export interface AppBootstrap {
  platform: Platform;
  /** The OS "reduce transparency" flag. Only macOS reports it; elsewhere CSS `prefers-reduced-transparency` does. */
  reducedTransparency: boolean;
  version: string;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

/** Validates a settings object from the backend. `null` if it is not one. */
export function parseSettings(value: unknown): Settings | null {
  if (typeof value !== 'object' || value === null) return null;
  const { glass, theme } = value as { glass?: unknown; theme?: unknown };
  const parsedGlass = oneOf(GLASS_MODES, glass);
  const parsedTheme = oneOf(THEME_MODES, theme);
  return parsedGlass !== null && parsedTheme !== null ? { glass: parsedGlass, theme: parsedTheme } : null;
}

/** Validates the startup report from the backend. `null` if it is not one. */
export function parseBootstrap(value: unknown): AppBootstrap | null {
  if (typeof value !== 'object' || value === null) return null;
  const { platform, reducedTransparency, version } = value as {
    platform?: unknown;
    reducedTransparency?: unknown;
    version?: unknown;
  };
  const parsedPlatform = oneOf(PLATFORMS, platform);
  if (parsedPlatform === null || typeof reducedTransparency !== 'boolean' || typeof version !== 'string') return null;
  return { platform: parsedPlatform, reducedTransparency, version };
}

/** An answer that does not have the documented shape is an internal error, like a malformed frame. */
function validated<T>(value: T | null): T {
  if (value === null) throw toAppError(null);
  return value;
}

export async function appReady(): Promise<AppBootstrap> {
  return validated(parseBootstrap(await call<unknown>('app_ready')));
}

export async function getSettings(): Promise<Settings> {
  return validated(parseSettings(await call<unknown>('get_settings')));
}

/** Applies `patch` and resolves to the settings after the update. Rejects with `invalid_argument` on a bad value. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return validated(parseSettings(await call<unknown>('update_settings', { patch })));
}

/** The new value of the OS "reduce transparency" flag from a channel message, `null` if the message is not a boolean. */
export function parseTransparencyMessage(message: unknown): boolean | null {
  return typeof message === 'boolean' ? message : null;
}

/**
 * Starts receiving changes of the OS "reduce transparency" flag: `onChange` gets each new value (macOS; elsewhere the
 * flag never changes), including one that already differs from what `app_ready` reported. The backend reaches the UI through this `Channel`, passed to a
 * command, and not through an event, because the window has no event permission (SECURITY T3). Calling it again
 * replaces the earlier channel. Rejects like any command.
 */
export async function watchTransparency(onChange: (reduced: boolean) => void): Promise<void> {
  const channel = new Channel<unknown>((message) => {
    const reduced = parseTransparencyMessage(message);
    if (reduced !== null) onChange(reduced);
  });
  await call<void>('watch_transparency', { onChange: channel });
}
