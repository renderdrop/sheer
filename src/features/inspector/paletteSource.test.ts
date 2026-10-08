// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { TAG_PALETTE } from '../../api/cite';
import { TONE_RGB } from '../annotations/stamps/actions';
import { TAG_COLOURS } from '../tags/palette';
import { defaultStyles, styleFor, useStyleStore } from './style';
import {
  activePalettes,
  defaultColours,
  PALETTE_RGB,
  PALETTE_SET_KEY,
  PALETTE_SET_NAMES,
  PALETTE_SETS,
  TAG_SWATCHES,
  usePaletteSet,
} from './palette';

afterEach(() => {
  localStorage.clear();
  usePaletteSet.setState({ set: 'iris' });
  useStyleStore.setState({ overrides: {} });
});

/** F19.19 (ADR-143): one five-colour list per set serves every picker. */
describe('one palette source', () => {
  it('has the four sets of five colours the owner chose', () => {
    expect(PALETTE_SET_NAMES).toEqual(['iris', 'earth', 'berry', 'study']);
    expect(PALETTE_RGB.iris).toEqual([
      [239, 53, 242],
      [0, 245, 255],
      [110, 242, 48],
      [255, 248, 77],
      [255, 65, 3],
    ]);
    expect(PALETTE_RGB.study[4]).toEqual([242, 237, 213]);
  });

  it('serves highlight, stroke and fill from the same five colours (stroke adds Ink first)', () => {
    for (const name of PALETTE_SET_NAMES) {
      const set = PALETTE_SETS[name];
      expect(set.highlight).toHaveLength(5);
      expect(set.fill.map((c) => c.rgb)).toEqual(set.highlight.map((c) => c.rgb));
      expect(set.stroke.map((c) => c.rgb).slice(1)).toEqual(set.highlight.map((c) => c.rgb));
      expect(set.stroke[0]?.id).toBe('ink');
      expect(set.highlight.every((c) => c.bg === undefined && c.nameKey.startsWith('colour.slot'))).toBe(true);
    }
  });

  it('keeps tags, stamps and the signature inks fixed', () => {
    expect(TAG_COLOURS.map((c) => c.fill)).toEqual(TAG_SWATCHES.map((c) => c.bg));
    expect(TAG_PALETTE).toEqual(TAG_SWATCHES.map((c) => c.rgb));
    expect(TONE_RGB.solar).toEqual([255, 248, 77]);
    usePaletteSet.getState().choose('berry');
    expect(activePalettes().signature.map((c) => c.id)).toEqual(['ink', 'signatureInk']);
    expect(TONE_RGB.solar).toEqual([255, 248, 77]);
  });

  it('takes the defaults from the active set: highlight at the Solar position, citation colour 5', () => {
    expect(defaultColours().highlight).toEqual(PALETTE_SETS.iris.highlight[3]?.rgb);
    usePaletteSet.getState().choose('earth');
    expect(defaultColours().highlight).toEqual(PALETTE_SETS.earth.highlight[3]?.rgb);
    expect(defaultColours().citation).toEqual(PALETTE_SETS.earth.highlight[4]?.rgb);
    expect(defaultColours().ink).toEqual([15, 15, 15]);
    expect(defaultStyles().highlight.opacity).toBe(0.45);
  });

  it('persists the choice app-wide and survives a broken storage', () => {
    usePaletteSet.getState().choose('study');
    expect(localStorage.getItem(PALETTE_SET_KEY)).toBe('study');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      expect(() => usePaletteSet.getState().choose('berry')).not.toThrow();
      expect(usePaletteSet.getState().set).toBe('berry');
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('never recolours stored styles when the set is switched', () => {
    const own = PALETTE_SETS.iris.highlight[1]?.rgb;
    if (own === undefined) throw new Error('palette');
    useStyleStore.getState().set('highlight', { color: own });
    usePaletteSet.getState().choose('earth');
    expect(styleFor('highlight').color).toEqual(own);
  });

  it('has no palette literal outside the palette module (features and components)', () => {
    const files = import.meta.glob(['../**/*.{ts,tsx}', '../../components/**/*.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const literal =
      /\[\s*(255,\s*248,\s*77|125,\s*235,\s*181|163,\s*222,\s*255|255,\s*199,\s*215|220,\s*207,\s*255)\s*\]|#(EF35F2|00F5FF|6EF230|FFF84D|FF4103|093699|B7CF4F|2A5239|DAD1CA|C54712|A61B4E|D92567|F2509C|D4D93D|D6CECE|174FBF|A7D5F2|1B4427|B0BF3F|F2EDD5)/i;
    const offenders = Object.entries(files)
      .filter(([path]) => !/\.test\.|testutil|^\.\/palette\.ts$|inspector\/palette\.ts$/.test(path))
      .filter(([, text]) => text.split('\n').some((line) => literal.test(line) && !line.includes('?? [')))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
