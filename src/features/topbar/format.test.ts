import { describe, expect, it } from 'vitest';

import { formatPageTotal, formatZoomStatus, parsePageInput } from './format';

describe('top bar formats', () => {
  it('formats the page total and the zoom', () => {
    expect(formatPageTotal(12, 'en')).toBe('/ 12');
    expect(formatPageTotal(12000, 'de')).toBe('/ 12.000');
    expect(formatZoomStatus(1.25, 'en')).toBe('125\u00a0%');
    expect(formatZoomStatus(Number.NaN, 'en')).toBe('–');
  });

  it('parses a typed page, rejecting everything that is not a page of the document', () => {
    expect(parsePageInput(' 3 ', 12)).toBe(2);
    expect(parsePageInput('12', 12)).toBe(11);
    expect(parsePageInput('0', 12)).toBeNull();
    expect(parsePageInput('13', 12)).toBeNull();
    expect(parsePageInput('2x', 12)).toBeNull();
    expect(parsePageInput('', 12)).toBeNull();
    expect(parsePageInput('1234567', 12)).toBeNull();
  });
});
