import { describe, expect, it } from 'vitest';

import { fitOneLine } from './fit';

/** A line that holds `n` characters, a stand-in for the measured width. */
const holds = (n: number) => (text: string) => text.length <= n;

describe('fitOneLine', () => {
  it('keeps a text that fits', () => {
    expect(fitOneLine('Autor A. Titel', holds(20))).toBe('Autor A. Titel');
  });

  it('drops trailing words until the text and the ellipsis fit', () => {
    expect(fitOneLine('Autor A. Ein langer Titel', holds(14))).toBe('Autor A. Ein…');
    expect(fitOneLine('Autor A. Ein langer Titel', holds(9))).toBe('Autor A.…');
  });

  it('cuts a single over-long word at the last grapheme that fits', () => {
    expect(fitOneLine('Donaudampfschifffahrtsgesellschaft Kapitän', holds(8))).toBe('Donauda…');
  });

  it('never splits a grapheme cluster', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const out = fitOneLine(`${family}${family}${family}`, (s) => s.replace('…', '').length <= family.length * 2);
    expect(out).toBe(`${family}${family}…`);
  });

  it('collapses white space and answers the bare ellipsis when nothing fits', () => {
    expect(fitOneLine('  a \n b  ', holds(10))).toBe('a b');
    expect(fitOneLine('abc', holds(0))).toBe('…');
    expect(fitOneLine('', holds(0))).toBe('');
  });
});
