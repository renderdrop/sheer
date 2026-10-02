import { describe, expect, it } from 'vitest';

import { primaryShortcut, shellShortcuts } from './shortcuts';

describe('primaryShortcut', () => {
  it('shows ⌘ on macOS and Ctrl+ elsewhere', () => {
    expect(primaryShortcut('macos', 'O').label).toBe('⌘O');
    expect(primaryShortcut('windows', 'O').label).toBe('Ctrl+O');
    expect(primaryShortcut('linux', 'O').label).toBe('Ctrl+O');
    expect(primaryShortcut(null, 'O').label).toBe('Ctrl+O');
  });

  it('announces both modifiers with the key name', () => {
    expect(primaryShortcut('windows', 'O').aria).toBe('Control+O Meta+O');
    expect(primaryShortcut('windows', '−', 'Minus').aria).toBe('Control+Minus Meta+Minus');
  });
});

describe('shellShortcuts', () => {
  it('lists the keys the shell binds', () => {
    const shortcuts = shellShortcuts('windows');
    expect(Object.values(shortcuts).map((shortcut) => shortcut.label)).toEqual([
      'Ctrl+O',
      'Ctrl+−',
      'Ctrl++',
      'Ctrl+0',
    ]);
  });
});
