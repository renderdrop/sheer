import { formatNumber, formatPercent, type Locale } from '../../i18n';

/** Text of the top bar (DESIGN v2 3.2). Pure functions, so the formats are tested without a DOM. */

/** "12": the total beside the page field ("12.000" in German). */
export function formatPageTotal(pageCount: number, locale: Locale): string {
  return `/ ${formatNumber(pageCount, locale)}`;
}

/** "125 %": the zoom value. A no-break space keeps the number and the sign together; "–" while the zoom is not known. */
export function formatZoomStatus(zoom: number, locale: Locale): string {
  return Number.isFinite(zoom) ? formatPercent(zoom, locale) : '–';
}

/** The page typed into the field as a zero-based index, or `null` when it is not a whole number from 1 to `pageCount`. */
export function parsePageInput(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  const page = /^[0-9]{1,6}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  return page >= 1 && page <= pageCount ? page - 1 : null;
}
