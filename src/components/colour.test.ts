import { describe, expect, it } from 'vitest';

import { contrastOnWhite, parseHex, pushRecent, toHex } from './colour';

describe('hex colours (DESIGN 3.5 B5)', () => {
  it('accepts 3 or 6 digits, with or without #, any case, spaces trimmed', () => {
    expect(parseHex('1F9E6A')).toEqual([31, 158, 106]);
    expect(parseHex(' #1f9e6a ')).toEqual([31, 158, 106]);
    expect(parseHex('#fa0')).toEqual([255, 170, 0]);
  });
  it('refuses 1, 2, 4, 5 digits, 7 digits and other characters', () => {
    for (const bad of ['', '1', '12', '1234', '12345', '1234567', 'GGGGGG', '12 456']) expect(parseHex(bad)).toBeNull();
  });
  it('normalises to six uppercase digits', () => {
    expect(toHex([1, 171, 255])).toBe('01ABFF');
  });
  it('knows low contrast on white', () => {
    expect(contrastOnWhite([255, 248, 77])).toBeLessThan(3);
    expect(contrastOnWhite([15, 15, 15])).toBeGreaterThan(15);
  });
});

describe('recent list', () => {
  it('puts the newest first, removes repeats and keeps 8', () => {
    let list: ReturnType<typeof pushRecent> = [];
    for (let n = 0; n < 10; n += 1) list = pushRecent(list, [n, 0, 0]);
    expect(list).toHaveLength(8);
    expect(list[0]).toEqual([9, 0, 0]);
    list = pushRecent(list, [5, 0, 0]);
    expect(list.map((c) => c[0])).toEqual([5, 9, 8, 7, 6, 4, 3, 2]);
  });
});
