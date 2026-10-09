/**
 * The arithmetic of Home's main column (DESIGN 3.18 H4). Two tiers: A (tall window, no "Open" row) is airy, B is tight. CSS sets the
 * measures from the `--home-*` tokens; this module decides which tier applies and sums the stack so a test can prove that it fits.
 */
export type HomeTier = 'a' | 'b';

/**
 * Window height from which tier A applies (when no document is open). DEVIATION: the spec says 1000, but its tier A stack sums to 1024
 * (1028 with 16 between tile rows); below that tier A would scroll, tier B fits.
 */
export const TIER_A_MIN_HEIGHT = 1024;
/** Below this height tier B drops the display title while the "Open" row shows. */
export const TITLE_MIN_HEIGHT = 900;

export function homeTier(height: number, openRow: boolean): HomeTier {
  return height >= TIER_A_MIN_HEIGHT && !openRow ? 'a' : 'b';
}

export function titleHidden(tier: HomeTier, openRow: boolean, height: number): boolean {
  return tier === 'b' && openRow && height < TITLE_MIN_HEIGHT;
}

/** The card variant: the Open row (tier B) shares the short card with Recent, so two rows fit; without it tier B uses the compact card. */
export type CardSize = 'full' | 'compact' | 'short';
export function cardSize(tier: HomeTier, openRow: boolean): CardSize {
  if (tier === 'a') return 'full';
  return openRow ? 'short' : 'compact';
}

/** Pixel measures of one tier (read from the tokens by the caller). */
export interface TierMeasures {
  paddingTop: number;
  paddingBottom: number;
  greetingRow: number;
  titleGap: number;
  titleHeight: number;
  searchGap: number;
  search: number;
  sectionGap: number;
  /** Section heading row. */
  heading: number;
  /** Heading to content. */
  headingGap: number;
  card: Record<CardSize, number>;
  tile: number;
  tileGap: number;
}

/** Height of the content from the window top to the bottom padding, for `tileRows` rows of tools (2 from 1100 wide, else 4). */
export function stackHeight(
  m: TierMeasures,
  tier: HomeTier,
  openRow: boolean,
  hideTitle: boolean,
  tileRows: number,
): number {
  const size = cardSize(tier, openRow);
  const section = (content: number) => m.sectionGap + m.heading + m.headingGap + content;
  let total = m.paddingTop + m.greetingRow;
  if (!hideTitle) total += m.titleGap + m.titleHeight;
  total += m.searchGap + m.search;
  if (openRow) total += section(m.card[size]);
  total += section(m.card[size]);
  total += section(tileRows * m.tile + (tileRows - 1) * m.tileGap);
  return total + m.paddingBottom;
}

/** The greeting for a local time (05:00-11:59 morning, 12:00-17:59 day, else evening). */
export function greetingPart(date: Date): 'morning' | 'day' | 'evening' {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'day';
  return 'evening';
}

/** Banner present and the window short: the title goes when the stack minus the banner is under this (no Open row). */
export const TITLE_BANNER_MIN_HEIGHT = 760;
/** Banner present: the short card replaces the compact one under this available height (no Open row). */
export const SHORT_CARD_BANNER_MIN_HEIGHT = 700;
/** Squeeze (less top padding and section gap) under these available heights, with a banner. */
export const SQUEEZE_MAX_HEIGHT = 660;
export const SQUEEZE_OPEN_MAX_HEIGHT = 800;

export interface HomeFit {
  tier: HomeTier;
  hideTitle: boolean;
  card: CardSize;
  /** Tighter padding and section gaps (`data-squeeze` in home.css). */
  squeeze: boolean;
}

/**
 * Everything the layout decides from the window height, the "Open" row and the height of the banner slot above Home (the recovery
 * banner, F19.17): the banner takes its height off the window, and the tiers step down (title, compact to short cards, squeeze)
 * until the stack fits. Without a banner it is exactly the plain tier logic.
 */
export function homeFit(height: number, openRow: boolean, banner: number): HomeFit {
  const available = height - Math.max(0, banner);
  const tier = homeTier(available, openRow);
  const banned = banner > 0 && tier === 'b';
  const hideTitle =
    titleHidden(tier, openRow, available) || (banned && !openRow && available < TITLE_BANNER_MIN_HEIGHT);
  let card = cardSize(tier, openRow);
  if (banned && card === 'compact' && available < SHORT_CARD_BANNER_MIN_HEIGHT) card = 'short';
  const squeeze = banned && available < (openRow ? SQUEEZE_OPEN_MAX_HEIGHT : SQUEEZE_MAX_HEIGHT);
  return { tier, hideTitle, card, squeeze };
}

/** Minimum width of a tool tile (`--home-tile-min-width`) and the gap between tiles (`--space-4`), in px. */
export const TILE_MIN_WIDTH = 184;
export const TILE_GAP = 16;
/** Tool area width from which four tiles fit in a row (two rows of four); `home.css` repeats it as a container query. */
export const TILES_WIDE_MIN_WIDTH = 4 * TILE_MIN_WIDTH + 3 * TILE_GAP;

/** Columns of the tool tiles for the width of their area: 4 (two rows of four) or 2 (four rows of two, subtitles hidden). */
export function tileColumns(width: number): 2 | 4 {
  return width >= TILES_WIDE_MIN_WIDTH ? 4 : 2;
}

/**
 * How much Home gives up so its column fits without scrolling (F20.1), by the measured height of the body: 0 = the plain tiers,
 * 1 = no title, short cards, tight paddings, 2 = no card thumbnails, small tool tiles. The numbers are the stack sums of
 * `homeFit.test.ts` (tier B, cards per level, tools in `rows` lines of tiles: 2 for four columns, 4 for two).
 */
export type FitLevel = 0 | 1 | 2;
const FIT_NEEDS: Record<FitLevel, { closed: Record<2 | 4, number>; open: Record<2 | 4, number> }> = {
  0: { closed: { 2: 748, 4: 820 }, open: { 2: 792, 4: 864 } },
  1: { closed: { 2: 524, 4: 596 }, open: { 2: 712, 4: 784 } },
  2: { closed: { 2: 348, 4: 412 }, open: { 2: 444, 4: 508 } },
};
export function fitNeeds(level: FitLevel, openRow: boolean, rows: 2 | 4): number {
  return FIT_NEEDS[level][openRow ? 'open' : 'closed'][rows];
}

/** The lowest level whose stack fits `bodyHeight`; 0 where nothing is measured (`bodyHeight` 0) or the window is tall (tier A). */
export function fitLevel(bodyHeight: number, tier: HomeTier, openRow: boolean, columns: 2 | 4): FitLevel {
  if (bodyHeight <= 0 || tier === 'a') return 0;
  const rows = columns === 4 ? 2 : 4;
  if (bodyHeight >= fitNeeds(0, openRow, rows)) return 0;
  return bodyHeight >= fitNeeds(1, openRow, rows) ? 1 : 2;
}
