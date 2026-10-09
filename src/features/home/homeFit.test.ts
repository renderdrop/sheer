import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TILE_GAP,
  TILE_MIN_WIDTH,
  TILES_WIDE_MIN_WIDTH,
  MAX_FIT,
  cardSize,
  greetingPart,
  homeFit,
  homeTier,
  nextFit,
  overflows,
  stackHeight,
  tileColumns,
  titleHidden,
  type TierMeasures,
} from './homeLayout';
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
/** Rows of tiles: four columns from 1100 wide, else two columns of four rows (used by the banner proofs below at their widths). */
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
});
describe('Home fits by measuring its scroller (F20.1)', () => {
  it('steps up one level per overflowing layout and stops at the last', () => {
    expect(nextFit(0, true)).toBe(1);
    expect(nextFit(1, true)).toBe(2);
    expect(nextFit(2, true)).toBe(3);
    expect(nextFit(MAX_FIT, true)).toBe(MAX_FIT);
    expect(nextFit(2, false)).toBe(2);
    expect(nextFit(0, false)).toBe(0);
  });
  it('counts overflow past 1 px of slack, and not without layout', () => {
    expect(overflows(544, 486)).toBe(true);
    expect(overflows(487, 486)).toBe(false);
    expect(overflows(0, 0)).toBe(false);
    expect(overflows(100, 0)).toBe(false);
  });
  it('has CSS for every level, and the plus stays in the greeting row when squeezed', () => {
    const css = readFileSync('src/features/home/home.css', 'utf8');
    for (let level = 2; level <= MAX_FIT; level++) expect(css).toContain(`.home-main[data-fit="${level}"] .home-thumb`);
    expect(/\.home-main\[data-squeeze\] {[^}]*--plus-top: var\(--pad-top\)/.test(css)).toBe(true);
  });
  it('clamps tile subtitles to one line', () => {
    const css = readFileSync('src/features/home/home.css', 'utf8');
    expect(/\.home-tile-sub {[^}]*-webkit-line-clamp: 1;[^}]*text-overflow: ellipsis/.test(css)).toBe(true);
  });
});
describe('Tool tiles by the width of their area (F20.2)', () => {
  it('switches from four columns to two below four minimum tiles with their gaps', () => {
    expect(TILES_WIDE_MIN_WIDTH).toBe(4 * TILE_MIN_WIDTH + 3 * TILE_GAP);
    expect(tileColumns(TILES_WIDE_MIN_WIDTH)).toBe(4);
    expect(tileColumns(TILES_WIDE_MIN_WIDTH - 1)).toBe(2);
    expect(tileColumns(666)).toBe(2);
  });
  it('keeps the constants, the token and the container query of home.css in step', () => {
    const css = readFileSync('src/features/home/home.css', 'utf8');
    expect(num('home-tile-min-width')).toBe(TILE_MIN_WIDTH);
    expect(num('space-4')).toBe(TILE_GAP);
    expect(css).toContain(`@container home-tools (min-width: ${TILES_WIDE_MIN_WIDTH}px)`);
    expect(css).toContain(`@container home-tools (max-width: ${TILES_WIDE_MIN_WIDTH - 0.02}px)`);
    const title = /.home-tile-title {[^}]*}/.exec(css)?.[0] ?? '';
    expect(title).toContain('overflow-wrap: normal');
    expect(title).toContain('word-break: keep-all');
    expect(title).not.toContain('anywhere');
  });
  it('reserves the space of the menu button in the card name in every card tier', () => {
    const css = readFileSync('src/features/home/home.css', 'utf8');
    expect(/\.home-card-name {[^}]*padding-inline-end: calc\(var\(--control-sm\)/.test(css)).toBe(true);
    expect(/data-card="full"\] \.home-card-name {[^}]*padding-inline-end/.test(css)).toBe(false);
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
describe('Home with a banner above it (F19.17)', () => {
  /** The stack of a fit, with the squeeze applied the way home.css does. */
  function fitted(width: number, height: number, openRow: boolean, banner: number): number {
    const fit = homeFit(height, openRow, banner);
    const m = measures(fit.tier);
    if (fit.squeeze) {
      m.paddingTop = num('space-4');
      m.sectionGap = num('space-4');
      m.searchGap = num('space-3');
      m.headingGap = num('space-2');
      m.paddingBottom = num('space-2');
    }
    const section = (content: number) => m.sectionGap + m.heading + m.headingGap + content;
    const tiles = tileRows(width);
    let sum = m.paddingTop + m.greetingRow;
    if (!fit.hideTitle) sum += m.titleGap + m.titleHeight;
    sum += m.searchGap + m.search;
    if (openRow) sum += section(m.card[fit.card]);
    sum += section(m.card[fit.card]);
    sum += section(tiles * m.tile + (tiles - 1) * m.tileGap);
    return sum + m.paddingBottom;
  }
  it('is the plain tier logic without a banner', () => {
    expect(homeFit(800, false, 0)).toEqual({ tier: 'b', hideTitle: false, card: 'compact', squeeze: false });
    expect(homeFit(800, true, 0)).toEqual({ tier: 'b', hideTitle: true, card: 'short', squeeze: false });
    expect(homeFit(1100, false, 0).tier).toBe('a');
  });
  it('fits 1280 x 800 with the banner (no Open row), for banners of 56 to 120', () => {
    for (const banner of [56, 72, 88, 104, 120])
      expect(fitted(1280, 800, false, banner)).toBeLessThanOrEqual(800 - banner);
  });
  it('fits 1280 x 800 with the banner and the Open row, for banners of 56 to 88', () => {
    for (const banner of [56, 72, 88]) expect(fitted(1280, 800, true, banner)).toBeLessThanOrEqual(800 - banner);
  });
  it('fits 1440 x 900 with a banner', () => {
    expect(fitted(1440, 900, false, 80)).toBeLessThanOrEqual(900 - 80);
    expect(fitted(1440, 900, true, 80)).toBeLessThanOrEqual(900 - 80);
  });
  it('leaves a tall window airy (the banner takes its height off first)', () => {
    expect(homeFit(1200, false, 80).tier).toBe('a');
    expect(homeFit(1080, false, 80).tier).toBe('b');
  });
});
