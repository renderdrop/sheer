/** A page range, 1-based and inclusive. */
export type PageRange = readonly [start: number, end: number];

const MAX_RANGES = 1000;

/**
 * Parses "1-3, 5, 8-" (DESIGN 3.30): commas separate, `8-` runs to the last page, every page is within 1 to `total`, a range
 * does not run backwards. `null` for anything else, including empty text.
 */
export function parseRanges(text: string, total: number): PageRange[] | null {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_RANGES || parts.some((part) => part === '')) return null;
  const ranges: PageRange[] = [];
  for (const part of parts) {
    const match = /^(\d{1,6})\s*(-\s*(\d{1,6})?)?$/.exec(part);
    if (match === null) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[3] === undefined ? total : Number(match[3]);
    if (start < 1 || end < start || end > total) return null;
    ranges.push([start, end]);
  }
  return ranges;
}

/** Whether the ranges follow each other from page 1 to `total` without gap or overlap: a split, not an extract. */
export function isPartition(ranges: readonly PageRange[], total: number): boolean {
  let next = 1;
  for (const [start, end] of ranges) {
    if (start !== next) return false;
    next = end + 1;
  }
  return next === total + 1;
}

/** The ranges of "every `n` pages" over `total` pages. */
export function everyN(n: number, total: number): PageRange[] {
  const ranges: PageRange[] = [];
  for (let start = 1; start <= total; start += n) ranges.push([start, Math.min(total, start + n - 1)]);
  return ranges;
}

/** Whole number from 1 to `max` in a field's text; `null` otherwise. */
export function parseCount(text: string, max: number): number | null {
  if (!/^\d{1,6}$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= 1 && value <= max ? value : null;
}

/** "1-3", "5": a range as the user writes it. */
export const rangeLabel = ([start, end]: PageRange): string => (start === end ? `${start}` : `${start}-${end}`);

/** The first three ranges, then an ellipsis when there are more. */
export function previewRanges(ranges: readonly PageRange[]): string {
  const head = ranges.slice(0, 3).map(rangeLabel).join(', ');
  return ranges.length > 3 ? `${head}, …` : head;
}

/** The 0-based page indices the ranges cover, each once, in the order written. */
export function pageIndices(ranges: readonly PageRange[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const [start, end] of ranges) {
    for (let page = start; page <= end; page += 1) {
      if (!seen.has(page)) {
        seen.add(page);
        out.push(page - 1);
      }
    }
  }
  return out;
}

/** A byte count as "1.2 MB" in `locale` (powers of 1000, as file managers show). */
export function formatSize(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}
