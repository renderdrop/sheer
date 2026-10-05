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

/** The label a page shows: its PDF page label, else its number. Pure; `index` is zero-based. */
export function pageLabelOf(label: string | null | undefined, index: number): string {
  return label !== null && label !== undefined && label.trim() !== '' ? label : String(index + 1);
}

/**
 * The page typed into the field as a zero-based index. A typed PDF page label (case-insensitive, first match) wins over a number,
 * so "ii" and a "1" in a document numbered from the body work; else a whole number from 1 to `pageCount`.
 */
export function parsePageTarget(text: string, pageCount: number, labels: readonly (string | null)[]): number | null {
  const typed = text.trim().toLowerCase();
  if (typed === '') return null;
  const byLabel = labels.findIndex((label) => label !== null && label.trim().toLowerCase() === typed);
  if (byLabel >= 0 && byLabel < pageCount) return byLabel;
  return parsePageInput(text, pageCount);
}
