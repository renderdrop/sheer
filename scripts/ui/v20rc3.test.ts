import { describe, expect, it } from 'vitest';

// @ts-expect-error plain .mjs without types
import * as v from './accept/v20rc3-pure.mjs';

describe('rc.3 acceptance helpers', () => {
  it('expects the editor rows of DESIGN 3.18 E1', () => {
    expect(v.expectedRows(900).body).toBe(678);
    expect(v.expectedRows(640).body).toBe(418);
    expect(v.expectedRows(640, false).body).toBe(446);
  });

  it('matches computed grid tracks', () => {
    const tracks = v.parseTracks('28px 42px 12px 98px 12px 678px 30px');
    expect(v.rowsMatch(tracks, 900)).toBe(true);
    expect(v.rowsMatch(tracks, 800)).toBe(false);
    expect(v.rowsMatch(v.parseTracks('42px 12px 98px 12px 446px 30px'), 640, false)).toBe(true);
  });

  it('knows the separators per mode and parses colours', () => {
    expect(v.SEPARATORS.pages).toBe(3);
    expect(v.parseRgb('rgba(255, 248, 77, 0.5)')).toEqual([255, 248, 77]);
    expect(v.parseRgb('transparent')).toBeNull();
  });

  it('builds the greeting for the time of day', () => {
    expect(v.expectedGreeting(8, '')).toBe('Good morning.');
    expect(v.expectedGreeting(12, 'Ada')).toBe('Good afternoon, Ada.');
    expect(v.expectedGreeting(23, ' ')).toBe('Good evening.');
  });

  it('counts phrases and colour differences', () => {
    expect(v.countOf('a x b x', 'x')).toBe(2);
    expect(v.coloursDiffer(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(v.coloursDiffer(['a', 'b'], ['a', 'c'])).toBe(true);
    expect(v.kindCounts([{ kind: 'footnote' }, { kind: 'footnote' }, { kind: 'contents' }])).toEqual({
      footnote: 2,
      contents: 1,
    });
  });

  it('generates PDFs with a valid skeleton', () => {
    const docs = [
      v.footnotePdf('bracket'),
      v.footnotePdf('superscript'),
      v.footnotePdf('asterisk'),
      v.imprintPdf(),
      v.plainPdf(2, 'T'),
    ];
    for (const buf of docs) {
      const s = buf.toString('latin1');
      expect(s.startsWith('%PDF-1.7')).toBe(true);
      expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(s).toContain('/Type /Catalog');
    }
    expect(v.imprintPdf().toString('latin1')).toContain('978-3-16-148410-0');
    expect(v.imagePdf(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 10, 10).toString('latin1')).toContain('/DCTDecode');
  });
});
