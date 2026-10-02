import { describe, expect, it } from 'vitest';

import { formatPageStatus, formatZoomStatus, splitForMiddleTruncation } from './status';

const NBSP = String.fromCharCode(0xa0);

describe('formatPageStatus', () => {
  it('shows the one-based page and the count', () => {
    expect(formatPageStatus(0, 1)).toBe('1 / 1');
    expect(formatPageStatus(2, 120)).toBe('3 / 120');
    expect(formatPageStatus(499, 500)).toBe('500 / 500');
  });
});

describe('formatZoomStatus', () => {
  it('rounds to whole percent with a no-break space before the sign', () => {
    expect(formatZoomStatus(1)).toBe(`100${NBSP}%`);
    expect(formatZoomStatus(1.25)).toBe(`125${NBSP}%`);
    expect(formatZoomStatus(0.67)).toBe(`67${NBSP}%`);
    expect(formatZoomStatus(0.333)).toBe(`33${NBSP}%`);
    expect(formatZoomStatus(4)).toBe(`400${NBSP}%`);
    expect(formatZoomStatus(0.25)).toBe(`25${NBSP}%`);
  });
});

describe('splitForMiddleTruncation', () => {
  it('keeps a short name whole', () => {
    expect(splitForMiddleTruncation('a.pdf')).toEqual({ head: 'a.pdf', tail: '' });
    expect(splitForMiddleTruncation('Invoice 2024.pdf')).toEqual({ head: 'Invoice 2024.pdf', tail: '' });
  });

  it('keeps the end of a long name, with its extension, outside the part that may be cut', () => {
    const parts = splitForMiddleTruncation('Quarterly report 2024 final.pdf');
    expect(parts).toEqual({ head: 'Quarterly report 2024 f', tail: 'inal.pdf' });
    expect(parts.head + parts.tail).toBe('Quarterly report 2024 final.pdf');
    expect(parts.tail.endsWith('.pdf')).toBe(true);
    expect(Array.from(parts.tail)).toHaveLength(8);
  });

  it('never splits a character made of two UTF-16 units', () => {
    const name = `${'📄'.repeat(20)}.pdf`;
    const { head, tail } = splitForMiddleTruncation(name);
    expect(head + tail).toBe(name);
    expect(Array.from(tail)).toHaveLength(8);
    expect(head.endsWith('\ud83d')).toBe(false);
    expect(tail.startsWith('\ude04')).toBe(false);
  });

  it('is empty for an empty name', () => {
    expect(splitForMiddleTruncation('')).toEqual({ head: '', tail: '' });
  });

  it('splits exactly above twice the tail: 16 characters stay whole, 17 give an 8 character tail', () => {
    const sixteen = 'abcdefgh12345.pd';
    expect(Array.from(sixteen)).toHaveLength(16);
    expect(splitForMiddleTruncation(sixteen)).toEqual({ head: sixteen, tail: '' });
    const seventeen = `${sixteen}f`;
    expect(splitForMiddleTruncation(seventeen)).toEqual({ head: 'abcdefgh1', tail: '2345.pdf' });
  });

  it('keeps the extension of a name at the 255 character limit and loses no character', () => {
    const name = `${'n'.repeat(251)}.pdf`;
    expect(name).toHaveLength(255);
    const { head, tail } = splitForMiddleTruncation(name);
    expect(head + tail).toBe(name);
    expect(tail.endsWith('.pdf')).toBe(true);
    expect(Array.from(tail)).toHaveLength(8);
  });

  it('a custom tail length is honoured, and a name that is only an extension stays whole', () => {
    expect(splitForMiddleTruncation('Quarterly report.pdf', 4)).toEqual({ head: 'Quarterly report', tail: '.pdf' });
    expect(splitForMiddleTruncation('.pdf')).toEqual({ head: '.pdf', tail: '' });
  });
});
