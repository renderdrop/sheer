import {
  emptyBibRecord,
  type BibRecord,
  type CitationInfo,
  type CitationStyle,
  type StyledBlock,
} from '../../../api/citations';
import { apa } from './apa';
import { chicago } from './chicago';
import { din } from './din';
import { mla } from './mla';
import type { StyleImpl } from './shared';
import { clean, fitRuns, quote, type Lang } from './text';

export type { CitationStyle, StyledBlock } from '../../../api/citations';
export type { Lang } from './text';

const STYLES: Record<CitationStyle, StyleImpl> = {
  apa7: apa,
  mla9: mla,
  chicago17AuthorDate: chicago,
  dinIso690: din,
};

/** The most characters of a quote in a list entry (a run holds 4 000, the marks and the citation come on top). */
const QUOTE_SHOWN_MAX = 3_900;

/** The reference entry of the document in a style, with the terms of `lang`. Never throws; an empty record gives "(n.d.)." */
export function formatReference(record: BibRecord, style: CitationStyle, lang: Lang): StyledBlock {
  return { runs: fitRuns(STYLES[style].reference(record, lang)) };
}

/** Whether the record has no title, no author and no year at all: the preview then shows nothing but the missing caption. */
export function isReferenceBlank(record: BibRecord | undefined): boolean {
  if (record === undefined) return true;
  const named = record.authors.some((p) => clean(p.family) !== '' || clean(p.given) !== '');
  return clean(record.title) === '' && clean(record.year) === '' && !named;
}

/** Whether the record lacks a title, an author or a year (the preview then says so). */
export function isReferenceIncomplete(record: BibRecord | undefined): boolean {
  if (record === undefined) return true;
  const named = record.authors.some((p) => clean(p.family) !== '' || clean(p.given) !== '');
  return clean(record.title) === '' || clean(record.year) === '' || !named;
}

/**
 * The in-text citation: APA "(Müller, 2021, p. 12)", DIN "(Müller 2021, S. 12)", Chicago "(Müller 2021, 12)", MLA "(Müller 12)".
 * Without a record, or without author or year, the style's own fallback: the short title, "n.d." / "o. J.".
 */
export function formatShortCitation(
  record: BibRecord | undefined,
  locator: string,
  style: CitationStyle,
  lang: Lang,
): string {
  return STYLES[style].short(record ?? emptyBibRecord(), clean(locator), lang);
}

interface Entry {
  quotes: string[];
  locators: string[];
}

/** The pages of a group as one locator: "12" or "12–13" (first to last, in page order). */
function joinLocators(locators: readonly string[]): string {
  const distinct = locators.filter((loc, index) => loc !== '' && locators.indexOf(loc) === index);
  const first = distinct[0];
  const last = distinct[distinct.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? first : `${first}–${last}`;
}

/**
 * The citation list: the reference first, then one entry for each citation in the given (page) order: the quote in the language's
 * quotation marks and the short citation. The pages of a group are one entry with one locator. A citation with no quote (a file
 * that forbids copying text) is its short citation alone.
 */
export function formatCitationList(
  record: BibRecord,
  citations: readonly CitationInfo[],
  style: CitationStyle,
  lang: Lang,
): StyledBlock[] {
  const entries: Entry[] = [];
  const byGroup = new Map<string, Entry>();
  for (const citation of citations) {
    let entry = citation.group === null ? undefined : byGroup.get(citation.group);
    if (entry === undefined) {
      entry = { quotes: [], locators: [] };
      entries.push(entry);
      if (citation.group !== null) byGroup.set(citation.group, entry);
    }
    const text = clean(citation.quote);
    if (text !== '') entry.quotes.push(text);
    entry.locators.push(clean(citation.locator));
  }
  const blocks: StyledBlock[] = [formatReference(record, style, lang)];
  for (const entry of entries) {
    const joined = entry.quotes.join(' … ');
    const shown = joined.length > QUOTE_SHOWN_MAX ? `${joined.slice(0, QUOTE_SHOWN_MAX - 1)}…` : joined;
    const short = formatShortCitation(record, joinLocators(entry.locators), style, lang);
    blocks.push({
      runs: fitRuns(
        shown === ''
          ? [{ text: short, italic: false }]
          : [
              { text: quote(shown, lang), italic: false },
              { text: ` ${short}`, italic: false },
            ],
      ),
    });
  }
  return blocks;
}

/** The blocks as text, one paragraph each, separated by a blank line. */
export function blocksToPlainText(blocks: readonly StyledBlock[]): string {
  return blocks.map((block) => block.runs.map((run) => run.text).join('')).join('\n\n');
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (c) => ESCAPES[c] ?? c);

/** The blocks as HTML paragraphs: every character escaped, italics as `<i>`. */
export function blocksToHtml(blocks: readonly StyledBlock[]): string {
  return blocks
    .map((block) => {
      const inner = block.runs
        .map((run) => (run.italic ? `<i>${escapeHtml(run.text)}</i>` : escapeHtml(run.text)))
        .join('');
      return `<p>${inner}</p>`;
    })
    .join('\n');
}
