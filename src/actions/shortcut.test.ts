import { describe, expect, it } from 'vitest';

import { translators } from '../i18n';
import {
  canonicalKey,
  formatBinding,
  isBareKey,
  matchesBinding,
  resolveBinding,
  toAccelerator,
  type Binding,
  type KeyEventLike,
} from './shortcut';

const en = translators.en;
const de = translators.de;

const event = (init: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

const OPEN: Binding = { key: 'o', mods: ['primary'] };

describe('resolveBinding', () => {
  const both = { default: { key: 'F4' }, macos: { key: '1', mods: ['alt', 'primary'] } } as const;

  it('takes the macOS binding on macOS and the default one everywhere else, also before the platform is known', () => {
    expect(resolveBinding(both, 'macos')).toEqual(both.macos);
    for (const platform of ['windows', 'linux', null] as const)
      expect(resolveBinding(both, platform)).toEqual(both.default);
  });

  it('falls back to the default on macOS when macOS has no binding of its own', () => {
    expect(resolveBinding({ default: OPEN }, 'macos')).toEqual(OPEN);
  });

  it('is null for an action without a shortcut, or one that has none on the platform', () => {
    expect(resolveBinding(undefined, 'macos')).toBeNull();
    expect(resolveBinding({}, 'windows')).toBeNull();
    expect(resolveBinding({ macos: OPEN }, 'windows')).toBeNull();
  });
});

describe('canonicalKey', () => {
  it('is the lowercase letter, whichever case the event has', () => {
    expect(canonicalKey({ key: 'o', code: 'KeyO' })).toBe('o');
    expect(canonicalKey({ key: 'O', code: 'KeyO' })).toBe('o');
  });

  it('follows the layout for Latin letters: Dvorak gives another key at the same position', () => {
    expect(canonicalKey({ key: 'o', code: 'KeyS' })).toBe('o');
  });

  it('falls back to the key position for letters that are not Latin (Cyrillic) or that Option has changed (macOS)', () => {
    expect(canonicalKey({ key: 'щ', code: 'KeyO' })).toBe('o');
    expect(canonicalKey({ key: 'ø', code: 'KeyO' })).toBe('o');
    // A letter of its own key keeps the key, so a Swedish or German layout does not hit another binding by position.
    expect(canonicalKey({ key: 'ö', code: 'Semicolon' })).toBe('ö');
  });

  it('is the digit of a digit key or numpad key by position, shifted or not (AZERTY needs Shift for the digits)', () => {
    expect(canonicalKey({ key: '0', code: 'Digit0' })).toBe('0');
    expect(canonicalKey({ key: '&', code: 'Digit1' })).toBe('1');
    expect(canonicalKey({ key: '¡', code: 'Digit1' })).toBe('1');
    expect(canonicalKey({ key: '2', code: 'Numpad2' })).toBe('2');
    expect(canonicalKey({ key: '2', code: '' })).toBe('2');
  });

  it('takes a numpad key as a digit only when NumLock made it one: with NumLock off it is End, an arrow, Home, Insert...', () => {
    expect(canonicalKey({ key: '1', code: 'Numpad1' })).toBe('1');
    expect(canonicalKey({ key: '0', code: 'Numpad0' })).toBe('0');
    expect(canonicalKey({ key: 'End', code: 'Numpad1' })).toBe('End');
    expect(canonicalKey({ key: 'ArrowDown', code: 'Numpad2' })).toBe('ArrowDown');
    expect(canonicalKey({ key: 'PageDown', code: 'Numpad3' })).toBe('PageDown');
    expect(canonicalKey({ key: 'ArrowLeft', code: 'Numpad4' })).toBe('ArrowLeft');
    expect(canonicalKey({ key: 'Clear', code: 'Numpad5' })).toBe('Clear');
    expect(canonicalKey({ key: 'Home', code: 'Numpad7' })).toBe('Home');
    expect(canonicalKey({ key: 'Insert', code: 'Numpad0' })).toBe('Insert');
    // The digit row is by position whatever the layout types there, the numpad is not.
    expect(canonicalKey({ key: '&', code: 'Digit1' })).toBe('1');
    expect(canonicalKey({ key: '&', code: 'Numpad1' })).toBe('&');
  });

  it('puts the plus and equals keys together as Plus, and the minus and underscore keys as Minus', () => {
    for (const key of ['+', '=']) expect(canonicalKey({ key, code: '' }), key).toBe('Plus');
    for (const key of ['-', '_']) expect(canonicalKey({ key, code: '' }), key).toBe('Minus');
    expect(canonicalKey({ key: '+', code: 'NumpadAdd' })).toBe('Plus');
    expect(canonicalKey({ key: '-', code: 'NumpadSubtract' })).toBe('Minus');
  });

  it('keeps other punctuation and the names of named keys', () => {
    expect(canonicalKey({ key: ',', code: 'Comma' })).toBe(',');
    expect(canonicalKey({ key: 'ArrowDown', code: 'ArrowDown' })).toBe('ArrowDown');
    expect(canonicalKey({ key: 'F4', code: 'F4' })).toBe('F4');
  });
});

describe('matchesBinding', () => {
  it('takes Ctrl as the primary modifier on Windows, Linux and when the platform is not known yet, and not Cmd', () => {
    for (const platform of ['windows', 'linux', null] as const) {
      expect(matchesBinding(event({ key: 'o', ctrlKey: true }), OPEN, platform), `${platform} ctrl`).toBe(true);
      expect(matchesBinding(event({ key: 'o', metaKey: true }), OPEN, platform), `${platform} meta`).toBe(false);
      expect(matchesBinding(event({ key: 'o' }), OPEN, platform), `${platform} bare`).toBe(false);
    }
  });

  it('takes Cmd as the primary modifier on macOS, and not Control', () => {
    expect(matchesBinding(event({ key: 'o', metaKey: true }), OPEN, 'macos')).toBe(true);
    expect(matchesBinding(event({ key: 'o', ctrlKey: true }), OPEN, 'macos')).toBe(false);
    expect(matchesBinding(event({ key: 'o', metaKey: true, ctrlKey: true }), OPEN, 'macos')).toBe(false);
  });

  it('wants the modifiers exactly: more or fewer do not match', () => {
    expect(matchesBinding(event({ key: 'o', ctrlKey: true, shiftKey: true }), OPEN, 'windows')).toBe(false);
    expect(matchesBinding(event({ key: 'o', ctrlKey: true, altKey: true }), OPEN, 'windows')).toBe(false);
    const withShift: Binding = { key: 'F4', mods: ['shift'] };
    expect(matchesBinding(event({ key: 'F4', shiftKey: true }), withShift, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: 'F4' }), withShift, 'windows')).toBe(false);
    expect(matchesBinding(event({ key: 'F4' }), { key: 'F4' }, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: 'F4', shiftKey: true }), { key: 'F4' }, 'windows')).toBe(false);
  });

  it('never takes AltGr (which Windows reports as Ctrl and Alt together) for Ctrl', () => {
    expect(matchesBinding(event({ key: 'o', ctrlKey: true, altKey: true }), OPEN, 'windows')).toBe(false);
  });

  it('does not compare Shift for plus and minus, where it only helps to type the character', () => {
    const zoomIn: Binding = { key: 'Plus', mods: ['primary'] };
    expect(matchesBinding(event({ key: '=', ctrlKey: true }), zoomIn, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: '+', ctrlKey: true, shiftKey: true }), zoomIn, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: '+', metaKey: true, shiftKey: true }), zoomIn, 'macos')).toBe(true);
    const zoomOut: Binding = { key: 'Minus', mods: ['primary'] };
    expect(matchesBinding(event({ key: '_', ctrlKey: true, shiftKey: true }), zoomOut, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: '+', ctrlKey: true }), zoomOut, 'windows')).toBe(false);
  });

  it('matches Option+Cmd+digit on macOS although Option changes the character', () => {
    const toggle: Binding = { key: '1', mods: ['alt', 'primary'] };
    expect(matchesBinding(event({ key: '¡', code: 'Digit1', altKey: true, metaKey: true }), toggle, 'macos')).toBe(
      true,
    );
    expect(matchesBinding(event({ key: '1', code: 'Digit1', metaKey: true }), toggle, 'macos')).toBe(false);
  });

  it('does not take Ctrl and a numpad key with NumLock off for Ctrl and a digit', () => {
    const actualSize: Binding = { key: '1', mods: ['primary'] };
    expect(matchesBinding(event({ key: '1', code: 'Numpad1', ctrlKey: true }), actualSize, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: 'End', code: 'Numpad1', ctrlKey: true }), actualSize, 'windows')).toBe(false);
  });

  it('matches a bare key only without any modifier', () => {
    const select: Binding = { key: 'v' };
    expect(matchesBinding(event({ key: 'v' }), select, 'windows')).toBe(true);
    expect(matchesBinding(event({ key: 'V', shiftKey: true }), select, 'windows')).toBe(false);
    expect(matchesBinding(event({ key: 'v', ctrlKey: true }), select, 'windows')).toBe(false);
    expect(matchesBinding(event({ key: 'v', metaKey: true }), select, 'macos')).toBe(false);
    expect(matchesBinding(event({ key: 'v', altKey: true }), select, 'macos')).toBe(false);
  });

  it('ignores the Windows key and, on macOS, the Control key, whatever else is held', () => {
    expect(matchesBinding(event({ key: 'v', metaKey: true }), { key: 'v' }, 'windows')).toBe(false);
    expect(matchesBinding(event({ key: 'v', ctrlKey: true }), { key: 'v' }, 'macos')).toBe(false);
  });
});

describe('isBareKey', () => {
  it('is a key that types a character, without Cmd, Ctrl or Alt', () => {
    expect(isBareKey({ key: 'v' })).toBe(true);
    expect(isBareKey({ key: 'v', mods: ['shift'] })).toBe(true);
    expect(isBareKey({ key: 'v', mods: ['primary'] })).toBe(false);
    expect(isBareKey({ key: 'ArrowDown', mods: ['alt'] })).toBe(false);
    expect(isBareKey({ key: '1', mods: ['alt', 'primary'] })).toBe(false);
  });

  it('is not a named key: F4 and the arrows type nothing', () => {
    expect(isBareKey({ key: 'F4' })).toBe(false);
    expect(isBareKey({ key: 'ArrowDown' })).toBe(false);
  });
});

describe('formatBinding', () => {
  it('writes the chip in the style of the platform: symbols on macOS, key names elsewhere in the UI language', () => {
    expect(formatBinding(OPEN, 'macos', en).label).toBe('⌘O');
    expect(formatBinding(OPEN, 'macos', de).label).toBe('⌘O');
    expect(formatBinding(OPEN, 'windows', en).label).toBe('Ctrl+O');
    expect(formatBinding(OPEN, 'linux', de).label).toBe('Strg+O');
    expect(formatBinding(OPEN, null, de).label).toBe('Strg+O');
  });

  it('orders modifiers as the platform does: Option, Shift, Command on macOS; Ctrl, Alt, Shift elsewhere', () => {
    const all: Binding = { key: 'k', mods: ['shift', 'primary', 'alt'] };
    expect(formatBinding(all, 'macos', en).label).toBe('⌥⇧⌘K');
    expect(formatBinding(all, 'windows', en).label).toBe('Ctrl+Alt+Shift+K');
    expect(formatBinding(all, 'windows', de).label).toBe('Strg+Alt+Umschalt+K');
  });

  it('shows the symbols of plus, minus and the arrows', () => {
    expect(formatBinding({ key: 'Plus', mods: ['primary'] }, 'windows', en).label).toBe('Ctrl++');
    expect(formatBinding({ key: 'Minus', mods: ['primary'] }, 'macos', en).label).toBe('⌘−');
    expect(formatBinding({ key: 'ArrowDown', mods: ['alt'] }, 'windows', en).label).toBe('Alt+↓');
    expect(formatBinding({ key: 'ArrowUp', mods: ['alt'] }, 'macos', en).label).toBe('⌥↑');
    expect(formatBinding({ key: ',', mods: ['primary'] }, 'macos', en).label).toBe('⌘,');
  });

  it('shows a bare key and a function key as they are', () => {
    expect(formatBinding({ key: 'v' }, 'windows', en).label).toBe('V');
    expect(formatBinding({ key: 'F4' }, 'windows', de).label).toBe('F4');
    expect(formatBinding({ key: 'F4', mods: ['shift'] }, 'windows', de).label).toBe('Umschalt+F4');
  });

  it('announces W3C key names with the modifier of the platform only, in every language', () => {
    for (const t of [en, de]) {
      expect(formatBinding(OPEN, 'windows', t).aria, t.locale).toBe('Control+O');
      expect(formatBinding(OPEN, 'linux', t).aria, t.locale).toBe('Control+O');
      expect(formatBinding(OPEN, 'macos', t).aria, t.locale).toBe('Meta+O');
      expect(formatBinding({ key: 'Plus', mods: ['primary'] }, 'windows', t).aria, t.locale).toBe('Control+Plus');
      expect(formatBinding({ key: 'Minus', mods: ['primary'] }, 'macos', t).aria, t.locale).toBe('Meta+Minus');
      expect(formatBinding({ key: '1', mods: ['alt', 'primary'] }, 'macos', t).aria, t.locale).toBe('Alt+Meta+1');
      expect(formatBinding({ key: 'F4', mods: ['shift'] }, 'windows', t).aria, t.locale).toBe('Shift+F4');
      expect(formatBinding({ key: 'v' }, 'windows', t).aria, t.locale).toBe('V');
    }
  });
});

describe('toAccelerator', () => {
  it('writes the native menu syntax: CmdOrCtrl, Alt, Shift, then the key', () => {
    expect(toAccelerator(OPEN)).toBe('CmdOrCtrl+O');
    expect(toAccelerator({ key: '1', mods: ['alt', 'primary'] })).toBe('CmdOrCtrl+Alt+1');
    expect(toAccelerator({ key: 'k', mods: ['shift', 'alt', 'primary'] })).toBe('CmdOrCtrl+Alt+Shift+K');
  });

  it('names the plus key Equal (a physical key has no plus), minus as Minus, and keeps the names of named keys and punctuation', () => {
    expect(toAccelerator({ key: 'Plus', mods: ['primary'] })).toBe('CmdOrCtrl+Equal');
    expect(toAccelerator({ key: 'Minus', mods: ['primary'] })).toBe('CmdOrCtrl+Minus');
    expect(toAccelerator({ key: 'ArrowDown', mods: ['alt'] })).toBe('Alt+ArrowDown');
    expect(toAccelerator({ key: ',', mods: ['primary'] })).toBe('CmdOrCtrl+,');
    expect(toAccelerator({ key: 'F4' })).toBe('F4');
  });
});
