import type { BibRecord, CitationStyle } from '../../api/citations';
import { formatShortCitation } from '../citations/format';

/** The quotation marks of the UI language: “…” for English, „…“ for German (DESIGN 3.7 C3). */
export function quoteMarks(locale: string): readonly [string, string] {
  return locale === 'de' ? ['\u201E', '\u201C'] : ['\u201C', '\u201D'];
}

/** The short citation of a record in a style (the style's own fallback when author or year is missing). */
export function shortCitationText(record: BibRecord, locator: string, style: CitationStyle, locale: string): string {
  return formatShortCitation(record, locator, style, locale === 'de' ? 'de' : 'en');
}

/** Whether the record has no author or no year, so the bubble offers "Add reference details" (DESIGN 3.7 C3). */
export function referenceIncomplete(record: BibRecord): boolean {
  const named = record.authors.some((person) => person.family.trim() !== '' || person.given.trim() !== '');
  return !named || (record.year ?? '').trim() === '';
}
