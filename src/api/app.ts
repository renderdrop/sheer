import { Channel } from '@tauri-apps/api/core';

import { LANGUAGES, type Language } from '../i18n/locale';
import { call } from './call';
import { toAppError } from './errors';

/** Wire names of the backend's `Platform` (src-tauri/src/platform/mod.rs). */
export const PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Wire names of the backend's `GlassMode`, `ThemeMode` and `Language` (storage/settings.rs). Keep in sync. */
export const GLASS_MODES = ['auto', 'solid'] as const;
export type GlassMode = (typeof GLASS_MODES)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export { LANGUAGES, type Language };

/**
 * Range and default of the left panel's width in px (src-tauri/src/limits.rs, DESIGN 2 and 3.8). A test checks these
 * against `PANEL` in src/components/tokens.ts, which the splitter uses.
 */
export const LEFT_PANEL_WIDTH = { min: 192, max: 400, default: 248 } as const;

/** The persisted settings. "Glass: Solid" forces opaque surfaces; the theme and the language override the OS. */
export interface Settings {
  glass: GlassMode;
  theme: ThemeMode;
  /** "system" follows the OS language (German for `de*`, English otherwise). */
  language: Language;
  /** Width of the left panel in px, an integer from `LEFT_PANEL_WIDTH.min` to `.max`. */
  leftPanelWidth: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  glass: 'auto',
  theme: 'system',
  language: 'system',
  leftPanelWidth: LEFT_PANEL_WIDTH.default,
};

/** A partial update. The backend rejects unknown keys and values with `invalid_argument`. */
export type SettingsPatch = Partial<Settings>;

/** What the backend reports at startup (`app_ready`). */
export interface AppBootstrap {
  platform: Platform;
  /** The OS "reduce transparency" flag. Only macOS reports it; elsewhere CSS `prefers-reduced-transparency` does. */
  reducedTransparency: boolean;
  version: string;
}

function isPanelWidth(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= LEFT_PANEL_WIDTH.min &&
    value <= LEFT_PANEL_WIDTH.max
  );
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

/** Validates a settings object from the backend. `null` if it is not one. */
export function parseSettings(value: unknown): Settings | null {
  if (typeof value !== 'object' || value === null) return null;
  const { glass, theme, language, leftPanelWidth } = value as {
    glass?: unknown;
    theme?: unknown;
    language?: unknown;
    leftPanelWidth?: unknown;
  };
  const parsedGlass = oneOf(GLASS_MODES, glass);
  const parsedTheme = oneOf(THEME_MODES, theme);
  const parsedLanguage = oneOf(LANGUAGES, language);
  if (parsedGlass === null || parsedTheme === null || parsedLanguage === null || !isPanelWidth(leftPanelWidth)) {
    return null;
  }
  return { glass: parsedGlass, theme: parsedTheme, language: parsedLanguage, leftPanelWidth };
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

/** The longest menu id the UI accepts from the backend; ids are short kebab-case names (`src/actions/menu.json`). */
const MAX_MENU_ID_LENGTH = 64;

/** The id of the menu item that was chosen, from a channel message; `null` if the message is not a plausible id (a string of lowercase letters, digits and dashes). */
export function parseMenuMessage(message: unknown): string | null {
  return typeof message === 'string' &&
    message.length <= MAX_MENU_ID_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(message)
    ? message
    : null;
}

/**
 * Starts receiving the native menu bar's commands (macOS): `onAction` gets the id of each item the user chooses. Like
 * `watchTransparency` this is a `Channel` passed to a command, not an event (no event permission, SECURITY T3, ADR-016); the backend
 * only sends ids from its allowlist and the UI only runs ids it has an action for. `systemLanguage` (`navigator.language`) lets
 * the backend label the menu when the language setting is "system". Calling it again replaces the earlier channel. Rejects like
 * any command.
 */
export async function subscribeMenu(onAction: (id: string) => void, systemLanguage: string): Promise<void> {
  const channel = new Channel<unknown>((message) => {
    const id = parseMenuMessage(message);
    if (id !== null) onAction(id);
  });
  await call<void>('subscribe_menu', { onAction: channel, systemLanguage });
}
