import { describe, expect, it } from 'vitest';

import { translators } from '../i18n';
import { modifierLabel, shortcutLabel } from './shortcuts';

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
