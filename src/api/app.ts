import { Channel } from '@tauri-apps/api/core';

import { LANGUAGES, type Language } from '../i18n/locale';
import { call } from './call';
import { parseOpenOutcome, type OpenOutcome } from './documents';
import { toAppError } from './errors';
import { parseUpdateInfo, type UpdateInfo } from './update';

/** Wire names of the backend's `Platform` (src-tauri/src/platform/mod.rs). */
export const PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The paper the OS region suggests (`platform::paper_default`, ADR-049): letter in the US and Canada, A4 elsewhere. */
export const PAPER_DEFAULTS = ['a4', 'letter'] as const;
export type PaperDefault = (typeof PAPER_DEFAULTS)[number];

/** Wire names of the backend's `Language` (storage/settings.rs). Keep in sync. */
export { LANGUAGES, type Language };

/** Wire names of the backend's `WelcomeTour` (storage/settings.rs, ADR-023): "pending" until the first launch has opened the tour. */
export const WELCOME_TOUR_STATES = ['pending', 'shown'] as const;
export type WelcomeTour = (typeof WELCOME_TOUR_STATES)[number];

/**
 * Range and default of the left panel's width in px (src-tauri/src/limits.rs, DESIGN 2 and 3.8). A test checks these
 * against `PANEL` in src/components/tokens.ts, which the splitter uses.
 */
export const LEFT_PANEL_WIDTH = { min: 200, max: 320, default: 200 } as const;

/** The persisted settings. The language overrides the OS. */
export interface Settings {
  /** "system" follows the OS language (German for `de*`, English otherwise). */
  language: Language;
  /** Width of the left panel in px, an integer from `LEFT_PANEL_WIDTH.min` to `.max`. */
  leftPanelWidth: number;
  /** "pending" until the welcome tour has been started once; the UI writes "shown" before it opens the welcome document. */
  welcomeTour: WelcomeTour;
  /** The name put on annotations the user creates: empty (the default, no author is written, ADR-034) or up to `AUTHOR_NAME_MAX` characters, no control characters. */
  authorName: string;
  /** "pending" until the one-time author prompt on the first save with annotations has been confirmed or skipped. */
  authorPrompt: AuthorPrompt;
  /** The tools whose first-use tip was shown (DESIGN 3.47, ADR-054): tool ids, at most `TIPS_SEEN_MAX`. Absent until the backend knows the field. */
  tipsSeen?: readonly string[];
  /** "off" (the default) until the user allows the daily automatic update check (ADR-053 section 3). Absent until the backend knows the field. */
  updates?: UpdatesMode;
  /** The version the user chose not to be offered again, or `null` (`limits::UPDATE_VERSION_MAX_CHARS`). Absent until the backend knows the field. */
  skippedVersion?: string | null;
  /** The page sidebar is collapsed (DESIGN v2 3.2). Absent until the backend knows the field; absent means open. */
  pageSidebarCollapsed?: boolean;
}

/** Wire names of the backend's `UpdatesMode` (storage/settings.rs, ADR-053). */
export const UPDATES_MODES = ['off', 'on'] as const;
export type UpdatesMode = (typeof UPDATES_MODES)[number];

/** Longest `skippedVersion` in characters (`limits::UPDATE_VERSION_MAX_CHARS`). */
export const SKIPPED_VERSION_MAX = 32;

/** The most tool ids `tipsSeen` holds (DESIGN 3.47). */
export const TIPS_SEEN_MAX = 32;

function parseTipsSeen(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = (value as unknown[]).filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 32,
  );
  return ids.slice(0, TIPS_SEEN_MAX);
}

/** Wire names of the backend's `AuthorPrompt` (storage/settings.rs, ADR-034). */
export const AUTHOR_PROMPT_STATES = ['pending', 'done'] as const;
export type AuthorPrompt = (typeof AUTHOR_PROMPT_STATES)[number];

/** Longest author name in characters (`limits::MAX_AUTHOR_NAME_CHARS`). */
export const AUTHOR_NAME_MAX = 128;

/** Whether `value` is an author name the backend takes. */
export function isAuthorName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  return length <= AUTHOR_NAME_MAX && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  language: 'system',
  leftPanelWidth: LEFT_PANEL_WIDTH.default,
  welcomeTour: 'pending',
  authorName: '',
  authorPrompt: 'pending',
};

/** A partial update. The backend rejects unknown keys and values with `invalid_argument`. */
export type SettingsPatch = Partial<Settings>;

/** What the backend reports at startup (`app_ready`). */
export interface AppBootstrap {
  platform: Platform;
  version: string;
  /** The OS account name, only a suggestion for the author prompt (ADR-034); never stored. Empty when unknown. */
  authorSuggestion: string;
  /** Default page size of Create PDF from images (ADR-049): from the OS region, read in Rust. */
  paper: PaperDefault;
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
  const {
    language,
    leftPanelWidth,
    welcomeTour,
    authorName,
    authorPrompt,
    tipsSeen,
    updates,
    skippedVersion,
    pageSidebarCollapsed,
  } = value as {
    language?: unknown;
    leftPanelWidth?: unknown;
    welcomeTour?: unknown;
    authorName?: unknown;
    authorPrompt?: unknown;
    tipsSeen?: unknown;
    updates?: unknown;
    skippedVersion?: unknown;
    pageSidebarCollapsed?: unknown;
  };
  const parsedPrompt = oneOf(AUTHOR_PROMPT_STATES, authorPrompt);
  const parsedLanguage = oneOf(LANGUAGES, language);
  const parsedTour = oneOf(WELCOME_TOUR_STATES, welcomeTour);
  const parsedTips = parseTipsSeen(tipsSeen);
  const parsedUpdates = oneOf(UPDATES_MODES, updates);
  const parsedSkipped =
    typeof skippedVersion === 'string' && skippedVersion.length > 0 && skippedVersion.length <= SKIPPED_VERSION_MAX
      ? skippedVersion
      : skippedVersion === null
        ? null
        : undefined;
  if (
    parsedLanguage === null ||
    parsedTour === null ||
    parsedPrompt === null ||
    !isPanelWidth(leftPanelWidth) ||
    !isAuthorName(authorName)
  ) {
    return null;
  }
  return {
    language: parsedLanguage,
    leftPanelWidth,
    welcomeTour: parsedTour,
    authorName,
    authorPrompt: parsedPrompt,
    ...(parsedTips === undefined ? {} : { tipsSeen: parsedTips }),
    ...(parsedUpdates === null ? {} : { updates: parsedUpdates }),
    ...(parsedSkipped === undefined ? {} : { skippedVersion: parsedSkipped }),
    ...(typeof pageSidebarCollapsed === 'boolean' ? { pageSidebarCollapsed } : {}),
  };
}

/** Validates the startup report from the backend. `null` if it is not one. */
export function parseBootstrap(value: unknown): AppBootstrap | null {
  if (typeof value !== 'object' || value === null) return null;
  const { platform, version, authorSuggestion, paper } = value as {
    platform?: unknown;
    version?: unknown;
    authorSuggestion?: unknown;
    paper?: unknown;
  };
  const parsedPlatform = oneOf(PLATFORMS, platform);
  if (parsedPlatform === null || typeof version !== 'string') return null;
  return {
    platform: parsedPlatform,
    version,
    authorSuggestion: isAuthorName(authorSuggestion) ? authorSuggestion : '',
    paper: oneOf(PAPER_DEFAULTS, paper) ?? 'a4',
  };
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

/** Opens the OS page where the user picks the default PDF app (Windows; rejects with `unsupported_feature` on macOS). */
export function openDefaultAppsSettings(): Promise<void> {
  return call<void>('open_default_apps_settings');
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
 * Starts receiving the native menu bar's commands (macOS): `onAction` gets the id of each item the user chooses. This is a `Channel` passed to a command, not an event (no event permission, SECURITY T3, ADR-016); the backend
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

/**
 * What the backend pushes to the UI on the channel of `subscribeApp` (src-tauri/src/events.rs, `AppEvent`): whether files are
 * being dragged over the window, and how opening a file went when the UI did not ask for it (a file dropped on the window or
 * opened by the OS: file association, a second launch). The messages carry no path, only what the UI may know about a file.
 */
export type AppEvent =
  | { type: 'dropHover'; active: boolean; x?: number; y?: number }
  | { type: 'closeRequested' }
  | { type: 'imagesDropped'; batch: number; count: number; skipped: number }
  /** The PDF engine process was restarted; `lost` are the documents that could not be brought back and answer `engine_crashed` until reopened (ADR-053). */
  | { type: 'engineRestarted'; lost: number[] }
  /** The automatic update check found a newer version (ADR-053 section 3). */
  | { type: 'updateAvailable'; info: UpdateInfo }
  | OpenOutcome;

/** A pushed event from a channel message; `null` if the message is not one. */
export function parseAppEvent(message: unknown): AppEvent | null {
  if (typeof message !== 'object' || message === null) return null;
  const { type, active, batch, count, skipped, lost } = message as {
    type?: unknown;
    active?: unknown;
    batch?: unknown;
    count?: unknown;
    skipped?: unknown;
    lost?: unknown;
  };
  if (type === 'engineRestarted') {
    return Array.isArray(lost) &&
      lost.length <= 4096 &&
      lost.every((id) => typeof id === 'number' && Number.isInteger(id) && id >= 0)
      ? { type, lost: lost as number[] }
      : null;
  }
  if (type === 'updateAvailable') {
    const info = parseUpdateInfo((message as { info?: unknown }).info);
    return info === null ? null : { type, info };
  }
  if (type === 'closeRequested') return { type };
  if (type === 'dropHover') {
    if (typeof active !== 'boolean') return null;
    const { x, y } = message as { x?: unknown; y?: unknown };
    const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    return coord(x) && coord(y) ? { type, active, x, y } : { type, active };
  }
  if (type === 'imagesDropped') {
    const whole = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0;
    return whole(batch) && whole(count) && whole(skipped) ? { type, batch, count, skipped } : null;
  }
  return parseOpenOutcome(message);
}

/**
 * Starts receiving the backend's pushes: `onEvent` gets each `AppEvent`, first those that happened before this call (a file
 * the app was started with is opened while the window loads, and its result waits for the UI), in order, each once. Like
 * `watchTransparency` this is a `Channel` passed to a command, not an event: the window has no event permission, so it cannot
 * hear the `tauri://drag-drop` event whose payload is the dropped paths (SECURITY T3, T9). Calling it again replaces the earlier
 * channel. Rejects like any command. A message that is not an `AppEvent` is dropped.
 */
export async function subscribeApp(onEvent: (event: AppEvent) => void): Promise<void> {
  const channel = new Channel<unknown>((message) => {
    const event = parseAppEvent(message);
    if (event !== null) onEvent(event);
  });
  await call<void>('subscribe_app', { onEvent: channel });
}
