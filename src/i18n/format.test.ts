import { describe, expect, it } from 'vitest';

import { formatNumber, formatPercent } from './format';

const NBSP = String.fromCharCode(0xa0);

describe('formatNumber', () => {
  it('groups and separates the way the language does', () => {
    expect(formatNumber(120, 'en')).toBe('120');
    expect(formatNumber(1234, 'en')).toBe('1,234');
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(1234, 'de')).toBe('1.234');
    expect(formatNumber(1234.5, 'de')).toBe('1.234,5');
    expect(formatNumber(0, 'de')).toBe('0');
  });
});

describe('formatPercent', () => {
  it('writes a ratio as a whole percentage, with a no-break space before the sign in every language', () => {
    for (const locale of ['en', 'de'] as const) {
      expect(formatPercent(1, locale), locale).toBe(`100${NBSP}%`);
      expect(formatPercent(1.25, locale), locale).toBe(`125${NBSP}%`);
      expect(formatPercent(0.67, locale), locale).toBe(`67${NBSP}%`);
      expect(formatPercent(0.333, locale), locale).toBe(`33${NBSP}%`);
      expect(formatPercent(0.25, locale), locale).toBe(`25${NBSP}%`);
      expect(formatPercent(4, locale), locale).toBe(`400${NBSP}%`);
      expect(formatPercent(0, locale), locale).toBe(`0${NBSP}%`);
    }
  });

  it('rounds to whole percent, like the zoom steps are shown', () => {
    expect(formatPercent(0.666, 'en')).toBe(`67${NBSP}%`);
    expect(formatPercent(1.004, 'en')).toBe(`100${NBSP}%`);
    expect(formatPercent(1.006, 'en')).toBe(`101${NBSP}%`);
  });

  it('groups thousands like a number', () => {
    expect(formatPercent(12.5, 'en')).toBe(`1,250${NBSP}%`);
    expect(formatPercent(12.5, 'de')).toBe(`1.250${NBSP}%`);
  });

  it('does not double the space where the language already has one', () => {
    // German writes "125 %" with a no-break space of its own.
    expect(formatPercent(1.25, 'de').split(NBSP)).toHaveLength(2);
    expect(formatPercent(1.25, 'de')).not.toContain(`${NBSP}${NBSP}`);
  });
});
