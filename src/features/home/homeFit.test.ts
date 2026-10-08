import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cardSize, greetingPart, homeTier, stackHeight, titleHidden, type TierMeasures } from './homeLayout';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');
const num = (name: string): number => {
  const match = new RegExp(`--${name}:\\s*([0-9.]+)px;`).exec(tokens);
  if (match?.[1] === undefined) throw new Error(`token ${name} missing`);
  return Number(match[1]);
};

/** The measures of home.css per tier, built from the same tokens (jsdom has no layout; DESIGN 3.18 H4 proof). */
function measures(tier: 'a' | 'b'): TierMeasures {
  const a = tier === 'a';
  return {
    paddingTop: a ? num('space-24') : num('space-10'),
    paddingBottom: a ? num('space-12') + num('space-2') : num('space-4'),
    greetingRow: a ? num('control-sm') : num('home-plus'),
    titleGap: a ? num('space-3') : num('space-1'),
    // Two lines of the display title.
    titleHeight: 2 * num(a ? 'type-hero-line' : 'type-hero-compact-line'),
    searchGap: a ? num('space-8') + num('space-1') : num('space-6'),
    search: num('home-search-height'),
    sectionGap: a ? num('space-6') + num('space-1') : num('space-6'),
    heading: num('control-sm'),
    headingGap: a ? num('space-4') : num('space-3'),
    card: {
      full: num('home-card-height'),
      compact: num('home-card-height-compact'),
      short: num('home-card-height-short'),
    },
    tile: a ? num('home-tool-tile-height') : num('home-tool-tile-height-compact'),
    tileGap: num('space-3'),
  };
}

/** Rows of tiles: four columns from 1100 wide, else two columns of four rows. */
const tileRows = (width: number) => (width >= 1100 ? 2 : 4);

function total(width: number, height: number, openRow: boolean): number {
  const tier = homeTier(height, openRow);
  return stackHeight(measures(tier), tier, openRow, titleHidden(tier, openRow, height), tileRows(width));
}

describe('Home fits the window without a vertical scrollbar (DESIGN 3.18 H4)', () => {
  it('picks tier A only for a tall window without an Open row', () => {
    expect(homeTier(1024, false)).toBe('a');
    expect(homeTier(1023, false)).toBe('b');
    expect(homeTier(1200, true)).toBe('b');
    expect(cardSize('a', false)).toBe('full');
    expect(cardSize('b', false)).toBe('compact');
    expect(cardSize('b', true)).toBe('short');
  });

  it('hides the title in tier B only with the Open row and under 900 high', () => {
    expect(titleHidden('b', true, 800)).toBe(true);
    expect(titleHidden('b', true, 900)).toBe(false);
    expect(titleHidden('b', false, 800)).toBe(false);
    expect(titleHidden('a', false, 1024)).toBe(false);
  });

  it('fits 1280 x 800 without the Open row', () => {
    expect(total(1280, 800, false)).toBeLessThanOrEqual(800);
  });

  it('fits 1280 x 800 with the Open row (title hidden)', () => {
    expect(total(1280, 800, true)).toBeLessThanOrEqual(800);
  });

  it('matches the spec proof sums of H4 (748 and 792)', () => {
    expect(total(1280, 800, false)).toBe(748);
    expect(total(1280, 800, true)).toBe(792);
  });

  it('fits 1440 x 900 with and without the Open row, and tier A at 1440 x 1024', () => {
    expect(total(1440, 900, false)).toBeLessThanOrEqual(900);
    expect(total(1440, 900, true)).toBeLessThanOrEqual(900);
    expect(total(1440, 1024, false)).toBeLessThanOrEqual(1024);
  });

  it('builds the cards from their parts: padding, thumbnail, gap and the 28 name row', () => {
    for (const [card, thumb] of [
      ['home-card-height-compact', 'home-thumb-height-compact'],
      ['home-card-height-short', 'home-thumb-height-short'],
    ] as const) {
      expect(num(card)).toBe(2 * num('space-3') + num(thumb) + num('space-2') + num('control-sm'));
    }
    expect(measures('b').greetingRow).toBeGreaterThanOrEqual(num('home-plus'));
  });

  it('lets 960 x 640 scroll (two tile columns, four rows) rather than squeeze', () => {
    expect(total(960, 640, false)).toBeGreaterThan(640);
  });
});

describe('the greeting by time of day', () => {
  it('turns at 05:00, 12:00 and 18:00', () => {
    const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute);
    expect(greetingPart(at(4, 59))).toBe('evening');
    expect(greetingPart(at(5))).toBe('morning');
    expect(greetingPart(at(11, 59))).toBe('morning');
    expect(greetingPart(at(12))).toBe('day');
    expect(greetingPart(at(17, 59))).toBe('day');
    expect(greetingPart(at(18))).toBe('evening');
  });
});
