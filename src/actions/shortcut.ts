import type { Platform } from '../api/app';
import type { Translate } from '../i18n';
import { shortcutLabel, type Shortcut } from '../lib/shortcuts';

/**
 * The modifiers a binding can ask for. `primary` is the platform's command key: Cmd on macOS, Ctrl everywhere else (HIG and
 * the Windows guidelines; ux-patterns section 5). The other Control on macOS and the Windows key are never part of a binding,
 * and neither is Ctrl+Alt on Windows (AltGr).
 */
export type BindingMod = 'primary' | 'shift' | 'alt';

/**
 * A key combination in canonical form, the same on every platform it is bound on. `key` is `canonicalKey`'s name: a
 * lowercase letter, a digit, `Plus`, `Minus`, a punctuation character such as `,` or a `KeyboardEvent.key` name
 * (`ArrowDown`, `F4`). Written once; labels, `aria-keyshortcuts`, the native menu's accelerator and the key matching are all
 * derived from it, so no table can drift from another.
 */
export interface Binding {
  readonly key: string;
  readonly mods?: readonly BindingMod[];
}

/**
 * What an action is bound to: `default` (Windows, Linux and a platform that is not known yet) and, where macOS differs,
 * `macos`. An action without either has no shortcut.
 */
export interface Shortcuts {
  readonly default?: Binding;
  readonly macos?: Binding;
  /** Further bindings that run the action on every platform and are not shown (Redo is also Ctrl+Shift+Z on Windows). */
  readonly alternates?: readonly Binding[];
}

/** The binding on `platform`, or `null` when the action has none there. */
export function resolveBinding(shortcuts: Shortcuts | undefined, platform: Platform | null): Binding | null {
  if (shortcuts === undefined) return null;
  return (platform === 'macos' ? (shortcuts.macos ?? shortcuts.default) : shortcuts.default) ?? null;
}

/** Every binding that runs the action on : the one that is shown first, then the alternates. */
export function resolveBindings(shortcuts: Shortcuts | undefined, platform: Platform | null): readonly Binding[] {
  const shown = resolveBinding(shortcuts, platform);
  return [...(shown === null ? [] : [shown]), ...(shortcuts?.alternates ?? [])];
}

const hasMod = (binding: Binding, mod: BindingMod): boolean => binding.mods?.includes(mod) ?? false;

/**
 * Whether the binding is a key that types a character: no Cmd or Ctrl and no Alt. Such a binding is a single-key shortcut
 * (the tool letters), which works only while the canvas has focus; anywhere else the key belongs to whoever is typing.
 */
export function isBareKey(binding: Binding): boolean {
  return binding.key.length === 1 && !hasMod(binding, 'primary') && !hasMod(binding, 'alt');
}

/** The part of a keyboard event the matching reads (a real `KeyboardEvent` has it all). */
export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

const SYMBOL_KEYS: Readonly<Record<string, string>> = {
  '+': 'Plus',
  '=': 'Plus',
  '-': 'Minus',
  _: 'Minus',
  // Shift turns the bracket keys into braces (US layout); the tab shortcuts are Cmd+Shift+[ and ].
  '{': '[',
  '}': ']',
};

/**
 * The canonical name of the key an event is for (see `Binding.key`), independent of the modifiers and mostly of the layout:
 * - A letter is its lowercase Latin letter by the layout (Dvorak, QWERTZ), or by its position when the layout's letter is
 *   not Latin (Cyrillic, Greek) or macOS Option has turned it into something else.
 * - A digit is the digit key, by position, on the digit row (on AZERTY it needs Shift), and on the numpad only while it types
 *   digits: with NumLock off the numpad keys are End, the arrows, Home, Insert and so on, which must stay what they are.
 * - `+` and `=` are `Plus`, `-` and `_` are `Minus`: they share a key, and the layout decides which needs Shift.
 * - Anything else is the event's own key value.
 */
export function canonicalKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const { key, code } = event;
  const digit = /^(Digit|Numpad)([0-9])$/.exec(code);
  if (digit?.[2] !== undefined && (digit[1] === 'Digit' || /^[0-9]$/.test(key))) return digit[2];
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (/^[a-z]$/.test(lower)) return lower;
    const symbol = SYMBOL_KEYS[key];
    if (symbol !== undefined) return symbol;
    const position = /^Key([A-Z])$/.exec(code);
    if (position?.[1] !== undefined && /\p{L}/u.test(key)) return position[1].toLowerCase();
  }
  return key;
}

/**
 * Whether `event` is exactly `binding` on `platform`: the same key and the same modifiers, no more and no fewer. Shift is
 * not compared for `Plus` and `Minus`, where holding it is only a way to type the character. Cmd must be held on macOS and
 * Ctrl elsewhere; the other one of the two (Control on macOS, the Windows key) disqualifies the event, so Ctrl+O is not Cmd+O.
 */
export function matchesBinding(event: KeyEventLike, binding: Binding, platform: Platform | null): boolean {
  const mac = platform === 'macos';
  const primary = mac ? event.metaKey : event.ctrlKey;
  const stray = mac ? event.ctrlKey : event.metaKey;
  if (stray || primary !== hasMod(binding, 'primary') || event.altKey !== hasMod(binding, 'alt')) return false;
  const symbol = binding.key === 'Plus' || binding.key === 'Minus';
  if (!symbol && event.shiftKey !== hasMod(binding, 'shift')) return false;
  return canonicalKey(event) === binding.key;
}

/** Modifier order of a label: macOS lists Option, Shift, Command (HIG); Windows lists Ctrl, Alt, Shift. */
const LABEL_ORDER: Readonly<Record<'macos' | 'other', readonly BindingMod[]>> = {
  macos: ['alt', 'shift', 'primary'],
  other: ['primary', 'alt', 'shift'],
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  Plus: '+',
  Minus: '−',
  ArrowDown: '↓',
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
};

const KEY_ARIA: Readonly<Record<string, string>> = { Plus: 'Plus', Minus: 'Minus' };

function orderedMods(binding: Binding, platform: Platform | null): BindingMod[] {
  return LABEL_ORDER[platform === 'macos' ? 'macos' : 'other'].filter((mod) => hasMod(binding, mod));
}

/**
 * The shortcut as the UI shows and announces it. The chip is in the platform's style and the UI's language ("⌘⌥1",
 * "Ctrl+Shift+O", "Strg+Umschalt+O"). `aria` is `aria-keyshortcuts`: W3C key names, never translated, and the modifier of
 * the platform only (Meta on macOS, Control elsewhere), because that is the only one the key handler accepts.
 */
export function formatBinding(binding: Binding, platform: Platform | null, t: Translate): Shortcut {
  const mods = orderedMods(binding, platform);
  const keyLabel = KEY_LABELS[binding.key] ?? binding.key.toUpperCase();
  const ariaMod = (mod: BindingMod): string =>
    mod === 'primary' ? (platform === 'macos' ? 'Meta' : 'Control') : mod === 'alt' ? 'Alt' : 'Shift';
  const ariaKey = KEY_ARIA[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return {
    label: shortcutLabel(platform, t, mods, keyLabel),
    aria: [...mods.map(ariaMod), ariaKey].join('+'),
  };
}

/**
 * The accelerator string of the native menu for the macOS binding: `CmdOrCtrl+O`, `CmdOrCtrl+Alt+1`, `CmdOrCtrl+Equal`. Tauri
 * reads these as physical key names (muda's `Accelerator`), which have no `+`: the plus key is Equal, so the menu shows and
 * takes Cmd and =, while the key handler also takes Cmd and Shift and =. `src/actions/menu.json` holds the strings and a test
 * compares them with this function; a Rust test parses them with muda, because Tauri drops one it cannot parse without a word.
 */
export function toAccelerator(binding: Binding): string {
  const mods = (['primary', 'alt', 'shift'] as const)
    .filter((mod) => hasMod(binding, mod))
    .map((mod) => (mod === 'primary' ? 'CmdOrCtrl' : mod === 'alt' ? 'Alt' : 'Shift'));
  const key = binding.key === 'Plus' ? 'Equal' : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  return [...mods, key].join('+');
}
