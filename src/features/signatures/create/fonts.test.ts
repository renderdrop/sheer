// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FONT, itemFont, loadFont, normalizeFont, rememberItemFont, saveFont, stepFont } from './fonts';

beforeEach(() => window.localStorage.clear());

describe('signature fonts', () => {
  it('migrates unknown and removed fonts to the default', () => {
    expect(normalizeFont('homemadeApple')).toBe(DEFAULT_FONT);
    expect(normalizeFont(undefined)).toBe(DEFAULT_FONT);
    expect(normalizeFont('hurricane')).toBe('hurricane');
  });

  it('remembers the last font, default first', () => {
    expect(loadFont()).toBe('msMadi');
    saveFont('birthstone');
    expect(loadFont()).toBe('birthstone');
    window.localStorage.setItem('signatureFont', 'homemadeApple');
    expect(loadFont()).toBe('msMadi');
  });

  it('library entries remember their font; an old entry migrates', () => {
    rememberItemFont('a'.repeat(32), 'hurricane');
    expect(itemFont('a'.repeat(32))).toBe('hurricane');
    expect(itemFont('b'.repeat(32))).toBeNull();
    window.localStorage.setItem('sheer.signatureItemFonts', JSON.stringify({ old: 'homemadeApple' }));
    expect(itemFont('old')).toBe('msMadi');
    window.localStorage.setItem('sheer.signatureItemFonts', 'not json');
    expect(itemFont('old')).toBeNull();
  });

  it('steps with wrap', () => {
    expect(stepFont('birthstone', 1)).toBe('msMadi');
    expect(stepFont('msMadi', -1)).toBe('birthstone');
  });
});

describe('font list', () => {
  it('has exactly Ms Madi (default), Hurricane, Birthstone in this order', async () => {
    const { SIGNATURE_FONTS } = await import('./fonts');
    expect(SIGNATURE_FONTS.map((font) => font.id)).toEqual(['msMadi', 'hurricane', 'birthstone']);
    expect(SIGNATURE_FONTS.map((font) => font.name)).toEqual(['Ms Madi', 'Hurricane', 'Birthstone']);
    expect(DEFAULT_FONT).toBe('msMadi');
  });
  it('falls back to Ms Madi for removed ids', () => {
    for (const id of ['dancingScript', 'greatVibes', 'alexBrush']) expect(normalizeFont(id)).toBe('msMadi');
    window.localStorage.setItem('sheer.signatureItemFonts', JSON.stringify({ old: 'alexBrush' }));
    expect(itemFont('old')).toBe('msMadi');
  });
});
