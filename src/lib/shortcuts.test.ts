import { describe, expect, it } from 'vitest';

import { translators } from '../i18n';
import { modifierLabel, primaryShortcut, shellShortcuts, shortcutLabel } from './shortcuts';

const en = translators.en;
const de = translators.de;

describe('modifierLabel', () => {
  it('writes the key names in the language of the UI on Windows, Linux and when the platform is not known yet', () => {
    for (const platform of ['windows', 'linux', null] as const) {
      expect(modifierLabel(platform, 'primary', en), `${platform} en`).toBe('Ctrl');
      expect(modifierLabel(platform, 'control', en), `${platform} en`).toBe('Ctrl');
      expect(modifierLabel(platform, 'shift', en), `${platform} en`).toBe('Shift');
      expect(modifierLabel(platform, 'alt', en), `${platform} en`).toBe('Alt');
      expect(modifierLabel(platform, 'primary', de), `${platform} de`).toBe('Strg');
      expect(modifierLabel(platform, 'control', de), `${platform} de`).toBe('Strg');
      expect(modifierLabel(platform, 'shift', de), `${platform} de`).toBe('Umschalt');
      expect(modifierLabel(platform, 'alt', de), `${platform} de`).toBe('Alt');
    }
  });

  it('keeps the symbols on macOS, in every language', () => {
    for (const t of [en, de]) {
      expect(modifierLabel('macos', 'primary', t), t.locale).toBe('⌘');
      expect(modifierLabel('macos', 'control', t), t.locale).toBe('⌃');
      expect(modifierLabel('macos', 'shift', t), t.locale).toBe('⇧');
      expect(modifierLabel('macos', 'alt', t), t.locale).toBe('⌥');
    }
  });
});

describe('shortcutLabel', () => {
  it('joins words with "+" and symbols without a separator, modifiers in the order given', () => {
    expect(shortcutLabel('windows', en, ['primary', 'shift'], 'O')).toBe('Ctrl+Shift+O');
    expect(shortcutLabel('linux', de, ['primary', 'shift'], 'O')).toBe('Strg+Umschalt+O');
    expect(shortcutLabel('windows', de, ['primary', 'alt', 'shift'], 'K')).toBe('Strg+Alt+Umschalt+K');
    expect(shortcutLabel('macos', en, ['primary', 'shift'], 'O')).toBe('⌘⇧O');
    expect(shortcutLabel('macos', de, ['control', 'alt'], 'K')).toBe('⌃⌥K');
  });

  it('a key without modifiers is the key', () => {
    expect(shortcutLabel('windows', en, [], 'F1')).toBe('F1');
    expect(shortcutLabel('macos', de, [], 'F1')).toBe('F1');
  });
});

describe('primaryShortcut', () => {
  it('shows ⌘ on macOS and Ctrl+ elsewhere', () => {
    expect(primaryShortcut('macos', en, 'O').label).toBe('⌘O');
    expect(primaryShortcut('windows', en, 'O').label).toBe('Ctrl+O');
    expect(primaryShortcut('linux', en, 'O').label).toBe('Ctrl+O');
    expect(primaryShortcut(null, en, 'O').label).toBe('Ctrl+O');
  });

  it('shows Strg+ in German on Windows and Linux, and still ⌘ on macOS', () => {
    expect(primaryShortcut('windows', de, 'O').label).toBe('Strg+O');
    expect(primaryShortcut('linux', de, 'O').label).toBe('Strg+O');
    expect(primaryShortcut(null, de, 'O').label).toBe('Strg+O');
    expect(primaryShortcut('macos', de, 'O').label).toBe('⌘O');
  });

  it('announces both modifiers with the key name', () => {
    expect(primaryShortcut('windows', en, 'O').aria).toBe('Control+O Meta+O');
    expect(primaryShortcut('windows', en, '−', 'Minus').aria).toBe('Control+Minus Meta+Minus');
  });

  it('keeps the announced value the same on every platform and in every language', () => {
    for (const platform of ['macos', 'windows', 'linux', null] as const) {
      for (const t of [en, de]) {
        expect(primaryShortcut(platform, t, 'O').aria, `${platform} ${t.locale}`).toBe('Control+O Meta+O');
        expect(primaryShortcut(platform, t, '+', 'Plus').aria, `${platform} ${t.locale}`).toBe(
          'Control+Plus Meta+Plus',
        );
      }
    }
  });
});

describe('shellShortcuts', () => {
  it('lists the keys the shell binds', () => {
    const shortcuts = shellShortcuts('windows', en);
    expect(Object.values(shortcuts).map((shortcut) => shortcut.label)).toEqual([
      'Ctrl+O',
      'Ctrl+−',
      'Ctrl++',
      'Ctrl+0',
    ]);
  });

  it('follows the language on Windows and Linux', () => {
    for (const platform of ['windows', 'linux'] as const) {
      expect(Object.values(shellShortcuts(platform, de)).map((shortcut) => shortcut.label)).toEqual([
        'Strg+O',
        'Strg+−',
        'Strg++',
        'Strg+0',
      ]);
    }
  });

  it('uses the symbol on macOS in both languages', () => {
    for (const t of [en, de]) {
      expect(Object.values(shellShortcuts('macos', t)).map((shortcut) => shortcut.label)).toEqual([
        '⌘O',
        '⌘−',
        '⌘+',
        '⌘0',
      ]);
    }
  });

  it('announces canonical key names in both languages', () => {
    for (const t of [en, de]) {
      expect(Object.values(shellShortcuts('windows', t)).map((shortcut) => shortcut.aria)).toEqual([
        'Control+O Meta+O',
        'Control+Minus Meta+Minus',
        'Control+Plus Meta+Plus',
        'Control+0 Meta+0',
      ]);
    }
  });
});
