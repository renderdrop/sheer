import { describe, expect, it } from 'vitest';

import { TAG_PALETTE } from '../../api/cite';
import { TONE_RGB } from '../annotations/stamps/actions';
import { TAG_COLOURS } from '../tags/palette';
import {
  ACTIVE_PALETTE_SET,
  DEFAULT_COLOURS,
  HIGHLIGHT_PALETTE,
  PALETTE_SETS,
  PALETTES,
  SIGNATURE_PALETTE,
  STROKE_PALETTE,
} from './palette';

/** F19.14 (ADR-141): the colours every surface offers come from the one palette module. */
describe('one palette source', () => {
  it('serves every surface from the active named set', () => {
    expect(PALETTES).toBe(PALETTE_SETS[ACTIVE_PALETTE_SET]);
    expect(Object.keys(PALETTES).sort()).toEqual(['fill', 'highlight', 'signature', 'stroke']);
  });

  it('derives the tag colours, the stamp tones and the defaults from it', () => {
    expect(TAG_COLOURS.map((c) => c.fill)).toEqual(HIGHLIGHT_PALETTE.map((c) => c.bg));
    expect(TAG_COLOURS.map((c) => c.name)).toEqual(HIGHLIGHT_PALETTE.map((c) => c.nameKey));
    expect(TAG_PALETTE).toEqual(HIGHLIGHT_PALETTE.map((c) => c.rgb));
    expect(TONE_RGB.solar).toBe(HIGHLIGHT_PALETTE[0]?.rgb);
    expect(TONE_RGB.ink).toBe(STROKE_PALETTE[0]?.rgb);
    expect(DEFAULT_COLOURS.highlight).toBe(HIGHLIGHT_PALETTE[0]?.rgb);
    expect(SIGNATURE_PALETTE[0]?.rgb).toEqual(STROKE_PALETTE[0]?.rgb);
  });

  it('keeps every palette in the same order and with a name', () => {
    for (const palette of [HIGHLIGHT_PALETTE, STROKE_PALETTE]) {
      expect(palette.map((c) => c.id).slice(1)).toEqual(['mint', 'sky', 'rose', 'lavender']);
      expect(palette.every((c) => c.nameKey.startsWith('colour.'))).toBe(true);
    }
  });

  it('has no palette literal outside the palette module (features and components)', () => {
    const files = import.meta.glob(['../**/*.{ts,tsx}', '../../components/**/*.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const literal =
      /\[\s*(255,\s*248,\s*77|125,\s*235,\s*181|163,\s*222,\s*255|255,\s*199,\s*215|220,\s*207,\s*255)\s*\]/;
    const offenders = Object.entries(files)
      .filter(([path]) => !/\.test\.|testutil|^\.\/palette\.ts$/.test(path))
      .filter(([, text]) => text.split('\n').some((line) => literal.test(line) && !line.includes('?? [')))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
