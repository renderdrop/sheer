// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FONT, itemFont, loadFont, normalizeFont, rememberItemFont, saveFont, stepFont } from './fonts';

beforeEach(() => window.localStorage.clear());

describe('signature fonts', () => {
  it('migrates unknown and removed fonts to the default', () => {
    expect(normalizeFont('homemadeApple')).toBe(DEFAULT_FONT);
    expect(normalizeFont(undefined)).toBe(DEFAULT_FONT);
    expect(normalizeFont('greatVibes')).toBe('greatVibes');
  });

  it('remembers the last font, default first', () => {
    expect(loadFont()).toBe('dancingScript');
    saveFont('alexBrush');
    expect(loadFont()).toBe('alexBrush');
    window.localStorage.setItem('signatureFont', 'homemadeApple');
    expect(loadFont()).toBe('dancingScript');
  });

  it('library entries remember their font; an old entry migrates', () => {
    rememberItemFont('a'.repeat(32), 'greatVibes');
    expect(itemFont('a'.repeat(32))).toBe('greatVibes');
    expect(itemFont('b'.repeat(32))).toBeNull();
    window.localStorage.setItem('sheer.signatureItemFonts', JSON.stringify({ old: 'homemadeApple' }));
    expect(itemFont('old')).toBe('dancingScript');
    window.localStorage.setItem('sheer.signatureItemFonts', 'not json');
    expect(itemFont('old')).toBeNull();
  });

  it('steps with wrap', () => {
    expect(stepFont('alexBrush', 1)).toBe('dancingScript');
    expect(stepFont('dancingScript', -1)).toBe('alexBrush');
  });
});
