import { describe, expect, it } from 'vitest';

import { isConfirmKey } from './confirmKey';

const ev = (key: string, extra: { shiftKey?: boolean; keyCode?: number; composing?: boolean } = {}) => ({
  key,
  shiftKey: extra.shiftKey ?? false,
  keyCode: extra.keyCode,
  nativeEvent: { isComposing: extra.composing },
});

describe('isConfirmKey', () => {
  it('confirms on Enter', () => expect(isConfirmKey(ev('Enter'))).toBe(true));
  it('leaves Shift+Enter as a line break', () => expect(isConfirmKey(ev('Enter', { shiftKey: true }))).toBe(false));
  it('ignores Enter while an IME composes', () => {
    expect(isConfirmKey(ev('Enter', { composing: true }))).toBe(false);
    expect(isConfirmKey(ev('Enter', { keyCode: 229 }))).toBe(false);
  });
  it('ignores other keys', () => expect(isConfirmKey(ev('a'))).toBe(false));
});
