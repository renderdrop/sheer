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
