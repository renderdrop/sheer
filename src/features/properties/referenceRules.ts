import {
  BIB_AUTHORS_MAX,
  BIB_TEXT_FIELDS,
  emptyBibRecord,
  type BibField,
  type BibKind,
  type BibRecord,
  type BibSource,
  type BibTextField,
  type BibliographyInfo,
  type Person,
} from '../../api/citations';
import type { PlainKey } from '../../i18n';

/** The Reference tab as pure data (DESIGN 3.7 C5): what each type shows, the validation, the draft and the record it makes. */

/** The text fields shown after Year, per type (DESIGN 3.7 C5 table). `accessed` is added by `visibleFields` once a URL is there. */
export const FIELDS_BY_KIND: Record<BibKind, readonly BibTextField[]> = {
  book: ['edition', 'publisher', 'place', 'isbn', 'doi', 'url'],
  article: ['containerTitle', 'volume', 'issue', 'pages', 'doi', 'url'],
  chapter: ['containerTitle', 'pages', 'edition', 'publisher', 'place', 'isbn', 'doi'],
  report: ['publisher', 'place', 'doi', 'url'],
  webPage: ['containerTitle', 'url', 'accessed'],
  thesis: ['publisher', 'place', 'url'],
};

/** The type dropdown's options, in the order of the spec, with their string keys. */
export const KIND_OPTIONS: readonly { kind: BibKind; key: PlainKey }[] = [
  { kind: 'book', key: 'ref.type.book' },
  { kind: 'article', key: 'ref.type.article' },
  { kind: 'chapter', key: 'ref.type.chapter' },
  { kind: 'report', key: 'ref.type.report' },
  { kind: 'webPage', key: 'ref.type.web' },
  { kind: 'thesis', key: 'ref.type.thesis' },
];

/** The label of a text field for a type: the container is Journal, Book title or Website, the publisher an Institution. */
export function labelKey(kind: BibKind, field: BibTextField): PlainKey {
  switch (field) {
    case 'title':
      return 'ref.title';
    case 'year':
      return 'ref.year';
    case 'containerTitle':
      return kind === 'article' ? 'ref.journal' : kind === 'chapter' ? 'ref.bookTitle' : 'ref.website';
    case 'publisher':
      return kind === 'report' || kind === 'thesis' ? 'ref.institution' : 'ref.publisher';
    case 'volume':
      return 'ref.volume';
    case 'issue':
      return 'ref.issue';
    case 'pages':
      return 'ref.pages';
    case 'edition':
      return 'ref.edition';
    case 'place':
      return 'ref.place';
    case 'isbn':
      return 'ref.isbn';
    case 'doi':
      return 'ref.doi';
    case 'url':
      return 'ref.url';
    case 'accessed':
      return 'ref.accessed';
  }
}

/** An author row with a key that stays while the rows are moved. */
export interface AuthorRow {
  key: number;
  family: string;
  given: string;
}

/** What the form edits: text as strings (empty = no value). */
export interface RefDraft {
  kind: BibKind;
  authors: AuthorRow[];
  text: Record<BibTextField, string>;
}

let nextKey = 1;
/** A fresh author row. */
export function newAuthorRow(family = '', given = ''): AuthorRow {
  nextKey += 1;
  return { key: nextKey, family, given };
}

/** The draft of a record. */
export function draftOf(record: BibRecord): RefDraft {
  const text = {} as Record<BibTextField, string>;
  for (const field of BIB_TEXT_FIELDS) text[field] = record[field] ?? '';
  return { kind: record.kind, authors: record.authors.map((p) => newAuthorRow(p.family, p.given)), text };
}

/** The fields a type shows after Year; Accessed also appears once a URL is filled. */
export function visibleFields(kind: BibKind, url: string): readonly BibTextField[] {
  const fields = FIELDS_BY_KIND[kind];
  return fields.includes('accessed') || url.trim() === '' ? fields : [...fields, 'accessed'];
}

const YEAR = /^(\d{4}[a-z]?|n\.d\.|o\. ?J\.)$/;
const DOI = /^10\.[^\s/]+\/\S+$/;
const URL_FORM = /^https?:\/\/\S+$/i;

/** An ISBN-10 or ISBN-13 with its check digit; hyphens and spaces are allowed. */
export function isValidIsbn(value: string): boolean {
  const d = value.replace(/[- ]/g, '').toUpperCase();
  if (/^[0-9]{13}$/.test(d)) {
    return [...d].reduce((sum, c, i) => sum + Number(c) * (i % 2 === 0 ? 1 : 3), 0) % 10 === 0;
  }
  if (/^[0-9]{9}[0-9X]$/.test(d)) {
    return [...d].reduce((sum, c, i) => sum + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  }
  return false;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The error string key of a value, or `null` if it is fine (an empty value always is). */
export function validate(field: BibTextField, value: string): PlainKey | null {
  const v = value.trim();
  if (v === '') return null;
  if (field === 'year') return YEAR.test(v) ? null : 'ref.invalid.year';
  if (field === 'doi') return DOI.test(v) ? null : 'ref.invalid.doi';
  if (field === 'isbn') return isValidIsbn(v) ? null : 'ref.invalid.isbn';
  if (field === 'url') return URL_FORM.test(v) ? null : 'ref.invalid.url';
  if (field === 'accessed') return DATE.test(v) ? null : 'ref.invalid.year';
  return null;
}

/** The fields of the draft that are shown and invalid. */
export function invalidFields(draft: RefDraft): BibTextField[] {
  const shown: readonly BibTextField[] = ['year', ...visibleFields(draft.kind, draft.text.url)];
  return shown.filter((field) => validate(field, draft.text[field]) !== null);
}

const cut = (value: string): string | null => {
  const v = value.trim();
  return v === '' ? null : v;
};

/** The record the draft makes: trimmed, empty as `null`, the fields a type does not show dropped, rows without a name left out. */
export function recordOf(draft: RefDraft): BibRecord {
  const record = emptyBibRecord();
  record.kind = draft.kind;
  record.authors = draft.authors
    .map((row): Person => ({ family: row.family.trim(), given: row.given.trim() }))
    .filter((person) => person.family !== '' || person.given !== '')
    .slice(0, BIB_AUTHORS_MAX);
  const shown = new Set<BibTextField>(['title', 'year', ...visibleFields(draft.kind, draft.text.url)]);
  for (const field of BIB_TEXT_FIELDS) record[field] = shown.has(field) ? cut(draft.text[field]) : null;
  return record;
}

const peopleEqual = (a: readonly Person[], b: readonly Person[]): boolean =>
  a.length === b.length && a.every((p, i) => p.family === b[i]?.family && p.given === b[i]?.given);

/** Whether two records hold the same values. */
export function sameRecord(a: BibRecord, b: BibRecord): boolean {
  return a.kind === b.kind && peopleEqual(a.authors, b.authors) && BIB_TEXT_FIELDS.every((f) => a[f] === b[f]);
}

/** Whether the draft differs from what was loaded (the loaded record compared as the draft would write it). */
export function isChanged(draft: RefDraft, loaded: BibRecord): boolean {
  return !sameRecord(recordOf(draft), recordOf(draftOf(loaded)));
}

export type SourceCaption = 'file' | 'page1' | 'edited' | null;

/** The caption of a field: edited if the draft differs from the loaded value, else where the loaded value came from. */
export function captionOf(source: BibSource | undefined, edited: boolean, empty: boolean): SourceCaption {
  if (edited) return empty ? null : 'edited';
  if (source === 'user') return 'edited';
  if (source === 'heuristic') return 'page1';
  if (source === 'xmp' || source === 'info') return 'file';
  return null;
}

/** Whether the loaded value of a field is the file's (XMP, Info or page 1), so "edited" can be undone by restoring it. */
export function hasFileValue(info: BibliographyInfo, field: BibField): boolean {
  const source = info.sources[field];
  return source === 'xmp' || source === 'info' || source === 'heuristic';
}

/** Moves author row `from` to `to`; the same array if nothing moves. */
export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  const next = [...rows];
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return next;
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
