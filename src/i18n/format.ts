import type { Locale } from './locale';

const NO_BREAK_SPACE = String.fromCharCode(0xa0);

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const percentFormats = new Map<Locale, Intl.NumberFormat>();

function cached(cache: Map<Locale, Intl.NumberFormat>, locale: Locale, options?: Intl.NumberFormatOptions) {
  let format = cache.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, options);
    cache.set(locale, format);
  }
  return format;
}

/** A number the way the locale writes it: "1,234.5" in English, "1.234,5" in German. */
export function formatNumber(value: number, locale: Locale): string {
  return cached(numberFormats, locale).format(value);
}

/** The parts of a formatted number: when one of them comes right before the percent sign, the sign follows the digits directly ("125%"). */
const NUMBER_PARTS: ReadonlySet<string> = new Set(['integer', 'group', 'decimal', 'fraction']);

/**
 * A ratio as a whole percentage: 1.25 is "125 %". The digits and the position of the sign come from `Intl`. One house
 * rule is added (DESIGN 3.10): a sign that follows the number directly gets a no-break space first, so the number and
 * the sign never part at a line end and English reads "125 %" like German does.
 */
export function formatPercent(ratio: number, locale: Locale): string {
  const parts = cached(percentFormats, locale, { style: 'percent', maximumFractionDigits: 0 }).formatToParts(ratio);
  return parts
    .map((part, index) =>
      part.type === 'percentSign' && NUMBER_PARTS.has(parts[index - 1]?.type ?? '')
        ? NO_BREAK_SPACE + part.value
        : part.value,
    )
    .join('');
}
