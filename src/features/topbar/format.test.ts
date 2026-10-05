import { describe, expect, it } from 'vitest';

import { formatPageTotal, formatZoomStatus, pageLabelOf, parsePageInput, parsePageTarget } from './format';

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

describe('page labels in the page field', () => {
  const labels = ['i', 'ii', '1', '2', null];
  it('shows the label, else the number', () => {
    expect(pageLabelOf('ii', 1)).toBe('ii');
    expect(pageLabelOf(null, 4)).toBe('5');
    expect(pageLabelOf('  ', 0)).toBe('1');
  });
  it('goes to a typed label before a number', () => {
    expect(parsePageTarget('II', 5, labels)).toBe(1);
    expect(parsePageTarget('1', 5, labels)).toBe(2);
    expect(parsePageTarget('5', 5, labels)).toBe(4);
    expect(parsePageTarget('3', 5, labels)).toBe(2);
    expect(parsePageTarget('zz', 5, labels)).toBeNull();
    expect(parsePageTarget('', 5, labels)).toBeNull();
    expect(parsePageTarget('4', 5, [])).toBe(3);
  });
});
