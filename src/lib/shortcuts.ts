import type { Platform } from '../api/app';

/** A shortcut as the UI shows and announces it. */
export interface Shortcut {
  /** The key chip of a tooltip or menu item, formatted for the platform: "Ctrl+O" or "⌘O". */
  label: string;
  /** The `aria-keyshortcuts` value. Both modifiers are listed: the handlers accept Ctrl and Cmd on every platform. */
  aria: string;
}

/**
 * The shortcut "primary modifier + key". `key` is what the chip shows ("O", "−", "+", "0"); `ariaKey` is the key's name
 * for `aria-keyshortcuts` ("O", "Minus", "Plus", "0"). The command registry (ROADMAP Phase 3) takes over the binding itself.
 */
export function primaryShortcut(platform: Platform | null, key: string, ariaKey: string = key): Shortcut {
  return {
    label: platform === 'macos' ? `⌘${key}` : `Ctrl+${key}`,
    aria: `Control+${ariaKey} Meta+${ariaKey}`,
  };
}

/** The shortcuts the shell binds today (Ctrl or Cmd with O, plus, minus and 0). */
export function shellShortcuts(platform: Platform | null) {
  return {
    open: primaryShortcut(platform, 'O'),
    zoomOut: primaryShortcut(platform, '−', 'Minus'),
    zoomIn: primaryShortcut(platform, '+', 'Plus'),
    actualSize: primaryShortcut(platform, '0'),
  } as const;
}
