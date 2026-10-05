import type { BibKind, BibRecord, Run } from '../../../api/citations';
import { TERMS } from './terms';
import { clean, familyOf, isRange, normalisePages, quote, type Lang } from './text';
import type { Person } from '../../../api/citations';

/** One style: the reference entry and the short (in-text) citation. */
export interface StyleImpl {
  reference: (record: BibRecord, lang: Lang) => Run[];
  short: (record: BibRecord, locator: string, lang: Lang) => string;
}

/** The DOI resolver's address: printed text in a reference, never fetched (allowed by name in scripts/check.sh `guard_dist_urls`, SECURITY T2). */
const DOI_RESOLVER = 'https://doi.org/';

/** `https://doi.org/10.x/y` for a DOI in any of its common spellings. */
export function doiUrl(doi: string | null): string {
  const text = clean(doi);
  if (text === '') return '';
  if (/^https?:\/\//iu.test(text)) return text;
  return `${DOI_RESOLVER}${text.replace(/^doi:\s*/iu, '')}`;
}

export function bareDoi(doi: string | null): string {
  return clean(doi)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '');
}

/** "p. 12" or "pp. 12–13" ("S." for both in German). */
export function withTerm(pages: string, lang: Lang): string {
  const text = normalisePages(pages);
  if (text === '') return '';
  const terms = TERMS[lang];
  return `${isRange(text) ? terms.pp : terms.p} ${text}`;
}

/** The locator without a term ("12–13"). */
export const bare = (locator: string): string => normalisePages(locator);

/** Titles of these kinds are in quotation marks where a style does so for parts of a larger work. */
export const isPart = (kind: BibKind): boolean => kind === 'article' || kind === 'chapter' || kind === 'webPage';

/** The first words of the title: "A very long title about many things" -> "A very long title…". */
export function shortTitle(record: BibRecord, lang: Lang, quoted: boolean): string {
  const words = clean(record.title)
    .split(' ')
    .filter((w) => w !== '');
  if (words.length === 0) return '';
  const text =
    words
      .slice(0, 4)
      .join(' ')
      .replace(/[,;:.]$/u, '') + (words.length > 4 ? '…' : '');
  return quoted ? quote(text, lang) : text;
}

export type Names = 'apa' | 'and' | 'chicago';

/** Family names for an in-text citation: 1, 2 with a joiner, 3 and more "et al." (Chicago names up to three). */
export function shortNames(people: readonly Person[], lang: Lang, mode: Names): string {
  const names = people.map(familyOf);
  const terms = TERMS[lang];
  const [first, second, third] = names;
  if (first === undefined) return '';
  if (second === undefined) return first;
  const joiner = mode === 'apa' ? '&' : terms.and;
  if (names.length === 2) return `${first} ${joiner} ${second}`;
  if (mode === 'chicago' && third !== undefined && names.length === 3) {
    return lang === 'de' ? `${first}, ${second} und ${third}` : `${first}, ${second}, and ${third}`;
  }
  return `${first} ${terms.etAl}`;
}

/** Puts the title sentence first when there is no author; otherwise the author, `mid`, the title. */
export function arrange<T>(hasAuthors: boolean, authors: T, mid: readonly T[], body: readonly T[]): T[] {
  const [title, ...rest] = body;
  if (title === undefined) return hasAuthors ? [authors, ...mid] : [...mid];
  return hasAuthors ? [authors, ...mid, title, ...rest] : [title, ...mid, ...rest];
}
