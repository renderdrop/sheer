import { formatNumber, formatPercent, type Locale } from '../../i18n';

/** Text of the status bar (DESIGN 3.10). Pure functions, so the formats are tested without a DOM. */

/** "3 / 120" ("1.234 / 12.000" in German): the page button. `pageIndex` is zero-based. */
export function formatPageStatus(pageIndex: number, pageCount: number, locale: Locale): string {
  return `${formatNumber(pageIndex + 1, locale)} / ${formatNumber(pageCount, locale)}`;
}

/** "125 %": the zoom readout of the status bar and the toolbar. A no-break space keeps the number and the sign together. */
export function formatZoomStatus(zoom: number, locale: Locale): string {
  return formatPercent(zoom, locale);
}

/** The last characters of a file name that stay visible when the name does not fit (the extension and a bit before it). */
const TAIL_CHARS = 8;

/**
 * A file name in two parts for middle truncation (DESIGN 3.10): the head may be cut off with an ellipsis by CSS, the tail
 * always stays, so "Quarterly report 2024 final.pdf" can shrink to "Quarterly rep…nal.pdf" and the end of the name (its
 * extension) is never lost. A name that is short enough is all head. Counted in characters, not UTF-16 units, so a
 * surrogate pair is never split.
 */
export function splitForMiddleTruncation(name: string, tailChars: number = TAIL_CHARS): { head: string; tail: string } {
  const characters = Array.from(name);
  if (characters.length <= tailChars * 2) return { head: name, tail: '' };
  return { head: characters.slice(0, -tailChars).join(''), tail: characters.slice(-tailChars).join('') };
}
