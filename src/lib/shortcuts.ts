import type { Platform } from '../api/app';
import type { Translate } from '../i18n';

/** A shortcut as the UI shows and announces it. */
export interface Shortcut {
  /** The key chip of a tooltip or menu item, in the platform's style and the UI's language: "Ctrl+O", "Strg+O" or "⌘O". */
  label: string;
  /** The `aria-keyshortcuts` value. Canonical (W3C key names, never translated). Both modifiers are listed: the handlers accept Ctrl and Cmd on every platform. */
  aria: string;
}

/**
 * A modifier key of a shortcut. `primary` is the key that triggers commands on the platform (Cmd on macOS, Ctrl elsewhere);
 * `control` is the Control key itself, which only differs from `primary` on macOS.
 */
export type Modifier = 'primary' | 'control' | 'shift' | 'alt';

const MAC_SYMBOL: Readonly<Record<Modifier, string>> = { primary: '⌘', control: '⌃', shift: '⇧', alt: '⌥' };

/**
 * The name of a modifier on a keyboard that prints words on its keys (Windows, Linux): "Ctrl" or "Strg", "Shift" or
 * "Umschalt", "Alt". It is the label of a key cap, so it follows the UI's language.
 */
const WORD_KEY = {
  primary: 'shortcut.ctrl',
  control: 'shortcut.ctrl',
  shift: 'shortcut.shift',
  alt: 'shortcut.alt',
} as const satisfies Record<Modifier, string>;

/** How a modifier is shown for display: the symbol on macOS (it is the same in every language), the translated key name elsewhere. */
export function modifierLabel(platform: Platform | null, modifier: Modifier, t: Translate): string {
  return platform === 'macos' ? MAC_SYMBOL[modifier] : t(WORD_KEY[modifier]);
}

/** The chip text for `modifiers` and `key`, in the order given: "⌘⇧O" on macOS, "Ctrl+Shift+O" or "Strg+Umschalt+O" elsewhere. */
export function shortcutLabel(
  platform: Platform | null,
  t: Translate,
  modifiers: readonly Modifier[],
  key: string,
): string {
  const names = modifiers.map((modifier) => modifierLabel(platform, modifier, t));
  return platform === 'macos' ? `${names.join('')}${key}` : [...names, key].join('+');
}

/**
 * The shortcut "primary modifier + key". `key` is what the chip shows ("O", "−", "+", "0"); `ariaKey` is the key's name
 * for `aria-keyshortcuts` ("O", "Minus", "Plus", "0"). The command registry (ROADMAP Phase 3) takes over the binding itself.
 */
export function primaryShortcut(platform: Platform | null, t: Translate, key: string, ariaKey: string = key): Shortcut {
  return {
    label: shortcutLabel(platform, t, ['primary'], key),
    aria: `Control+${ariaKey} Meta+${ariaKey}`,
  };
}

/** The shortcuts the shell binds today (Ctrl or Cmd with O, plus, minus and 0). */
export function shellShortcuts(platform: Platform | null, t: Translate) {
  return {
    open: primaryShortcut(platform, t, 'O'),
    zoomOut: primaryShortcut(platform, t, '−', 'Minus'),
    zoomIn: primaryShortcut(platform, t, '+', 'Plus'),
    actualSize: primaryShortcut(platform, t, '0'),
  } as const;
}
