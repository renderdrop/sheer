import { describe, expect, it } from 'vitest';

import { layoutText, maxBoxWidth, startX, textWidth, wrapText } from './freeTextLayout';

describe('free text layout (DESIGN 3.5 B4)', () => {
  it('measures Helvetica: Hello at 12 pt is 27.336 pt', () => {
    expect(textWidth('Hello', 12)).toBeCloseTo(27.336, 3);
  });

  it('wraps at spaces, keeps line breaks and breaks a word that fits no line', () => {
    expect(wrapText('aa bb cc', 12, textWidth('aa bb', 12) + 0.1)).toEqual(['aa bb', 'cc']);
    expect(wrapText('a\n\nb', 12, 100)).toEqual(['a', '', 'b']);
    const long = wrapText('WWWWWWWWWWWW', 12, 40);
    expect(long.length).toBeGreaterThan(1);
    expect(long.join('')).toBe('WWWWWWWWWWWW');
  });

  it('max width is 288 or what the page leaves, never under 96; a click near the edge moves the box left', () => {
    expect(maxBoxWidth(50, 612)).toBe(288);
    expect(maxBoxWidth(500, 612)).toBe(100);
    expect(maxBoxWidth(600, 612)).toBe(96);
    expect(startX(100, 612)).toBe(100);
    expect(startX(600, 612)).toBe(612 - 12 - 96);
  });

  it('a new box hugs its text, grows to the max width, then down', () => {
    const from = { x: 50, y: 50, w: 24, h: 22.4 };
    const empty = layoutText('', 12, from, 612, false);
    expect(empty.box).toMatchObject({ w: 24, h: 22.4 });
    const short = layoutText('Hello there', 12, from, 612, false);
    expect(short.box.w).toBeGreaterThan(24);
    expect(short.box.w).toBeLessThan(90);
    const long = layoutText('word '.repeat(60), 12, from, 612, false);
    expect(long.box.w).toBeLessThanOrEqual(288);
    expect(long.lines.length).toBeGreaterThan(2);
    expect(long.box.h).toBeCloseTo(long.lines.length * 14.4 + 8, 5);
  });

  it('an existing box never shrinks', () => {
    const from = { x: 10, y: 10, w: 160, h: 36 };
    expect(layoutText('a', 12, from, 612, true).box).toEqual(from);
  });
});
