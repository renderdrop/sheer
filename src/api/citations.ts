import { applyCommand, parseChangeSet, type ChangeSet, type Rgb } from './annotations';
import { call } from './call';
import { parseTagNames } from './cite';
import { toAppError } from './errors';
import { isRecord, isUint, type Quad } from './wire';

/**
 * Citations, the bibliographic record and the citation list (ARCHITECTURE section 5 "Citations (v1.3, ADR-119)";
 * src-tauri/src/commands/{citations,bibliography,citation_export}.rs). Rust makes the quote and the page locator; the style formatting
 * is the frontend's (`src/features/citations/format`) and its output goes back as typed blocks, never markup. Every answer goes through
 * a parser here; one that does not have the documented shape is an internal error.
 */

/** Limits (src-tauri/src/limits.rs): drafts per call, citations per document, record field sizes, blocks and runs of a list. */
export const CITE_DRAFTS_MAX = 64;
export const CITATIONS_MAX = 20_000;
export const BIB_AUTHORS_MAX = 32;
export const BIB_PERSON_MAX = 256;
export const BIB_FIELD_MAX = 1_000;
export const BIB_YEAR_MAX = 16;
export const BIB_DOI_MAX = 256;
export const BIB_URL_MAX = 2_048;
export const PAGE_LABEL_MAX = 64;
export const CITATION_EXPORT_BLOCKS_MAX = 20_000;
export const STYLED_RUNS_MAX = 64;
export const STYLED_RUN_CHARS_MAX = 4_000;
/** Most characters of a quote, a comment and a group id on the wire. */
const QUOTE_UNITS_MAX = 4_000;
const CONTENTS_UNITS_MAX = 65_536;
const GROUP_UNITS_MAX = 16;

export const BIB_KINDS = ['book', 'article', 'chapter', 'report', 'webPage', 'thesis'] as const;
export type BibKind = (typeof BIB_KINDS)[number];

/** An author; an empty `given` is an organisation. */
export interface Person {
  family: string;
  given: string;
}

/** The text fields of a record (all `string | null`). */
export const BIB_TEXT_FIELDS = [
  'title',
  'year',
  'containerTitle',
  'volume',
  'issue',
  'pages',
  'edition',
  'publisher',
  'place',
  'doi',
  'url',
  'accessed',
] as const;
export type BibTextField = (typeof BIB_TEXT_FIELDS)[number];

/** The bibliographic record of a document (file: `/SHR_Bib` in `/Info`). `year` is text ("2020a", "n.d."), `accessed` is `YYYY-MM-DD`. */
export type BibRecord = {
  kind: BibKind;
  authors: Person[];
} & Record<BibTextField, string | null>;

/** Every field of a record that `BibliographyInfo.sources` names. */
export const BIB_FIELDS = ['kind', 'authors', ...BIB_TEXT_FIELDS] as const;
export type BibField = (typeof BIB_FIELDS)[number];

/** Where the value of a field comes from; `none` for an empty field. */
export const BIB_SOURCES = ['user', 'xmp', 'info', 'heuristic', 'none'] as const;
export type BibSource = (typeof BIB_SOURCES)[number];

/** What `get_bibliography` answers: the merged record, the source of each field, a pending edit, and a pending strip that drops the record. */
export interface BibliographyInfo {
  record: BibRecord;
  sources: Partial<Record<BibField, BibSource>>;
  pending: boolean;
  droppedByStrip: boolean;
}

/** An empty record: an article with no values. */
export function emptyBibRecord(): BibRecord {
  return {
    kind: 'article',
    authors: [],
    title: null,
    year: null,
    containerTitle: null,
    volume: null,
    issue: null,
    pages: null,
    edition: null,
    publisher: null,
    place: null,
    doi: null,
    url: null,
    accessed: null,
  };
}

const TEXT_FIELD_MAX: Record<BibTextField, number> = {
  title: BIB_FIELD_MAX,
  year: BIB_YEAR_MAX,
  containerTitle: BIB_FIELD_MAX,
  volume: BIB_FIELD_MAX,
  issue: BIB_FIELD_MAX,
  pages: BIB_FIELD_MAX,
  edition: BIB_FIELD_MAX,
  publisher: BIB_FIELD_MAX,
  place: BIB_FIELD_MAX,
  doi: BIB_DOI_MAX,
  url: BIB_URL_MAX,
  accessed: 10,
};

function parsePerson(value: unknown): Person | null {
  if (!isRecord(value)) return null;
  const { family, given } = value;
  if (typeof family !== 'string' || family.length > 2 * BIB_PERSON_MAX) return null;
  if (typeof given !== 'string' || given.length > 2 * BIB_PERSON_MAX) return null;
  return { family, given };
}

/** Validates a record; a missing field reads as `null`, as the backend's defaults do. `null` if it is not a record. */
export function parseBibRecord(value: unknown): BibRecord | null {
  if (!isRecord(value)) return null;
  const { kind, authors } = value;
  const parsedKind = BIB_KINDS.find((candidate) => candidate === kind);
  if (parsedKind === undefined) return null;
  const parsedAuthors: Person[] = [];
  if (authors !== undefined) {
    if (!Array.isArray(authors) || authors.length > BIB_AUTHORS_MAX) return null;
    for (const item of authors as unknown[]) {
      const person = parsePerson(item);
      if (person === null) return null;
      parsedAuthors.push(person);
    }
  }
  const record = emptyBibRecord();
  record.kind = parsedKind;
  record.authors = parsedAuthors;
  for (const field of BIB_TEXT_FIELDS) {
    const text = value[field];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string' || text.length > 2 * TEXT_FIELD_MAX[field]) return null;
    record[field] = text;
  }
  return record;
}

/** Validates the answer of `get_bibliography`; `null` if it is not one. Sources of unknown fields or values are dropped. */
export function parseBibliographyInfo(value: unknown): BibliographyInfo | null {
  if (!isRecord(value)) return null;
  const record = parseBibRecord(value.record);
  const { sources, pending, droppedByStrip } = value;
  if (record === null || !isRecord(sources) || typeof pending !== 'boolean' || typeof droppedByStrip !== 'boolean') {
    return null;
  }
  const parsedSources: Partial<Record<BibField, BibSource>> = {};
  for (const field of BIB_FIELDS) {
    const source = BIB_SOURCES.find((candidate) => candidate === sources[field]);
    if (source !== undefined) parsedSources[field] = source;
  }
  return { record, sources: parsedSources, pending, droppedByStrip };
}

/** One citation to create, on one page: the selection's rectangles (1 to 512) in page space. */
export interface CitationDraft {
  pageId: number;
  quads: readonly Quad[];
  color: Rgb;
  /** The user's comment, at most 32 768 characters; the quote is never part of it. */
  contents?: string;
  tags?: readonly string[];
}

/** A citation as `list_citations` reports it. */
export interface CitationInfo {
  id: number;
  pageId: number;
  /** The page label, or the position + 1; resolved when listed, so a page move shows. */
  locator: string;
  quote: string;
  contents: string;
  tags: string[];
  /** The group a selection across pages shares (8 hex characters); the export joins a group into one locator. */
  group: string | null;
  color: Rgb;
}

function parseRgb(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [r, g, b] = value as unknown[];
  return isUint(r, 255) && isUint(g, 255) && isUint(b, 255) ? [r, g, b] : null;
}

/** Validates one citation; `null` if it is not one. */
export function parseCitationInfo(value: unknown): CitationInfo | null {
  if (!isRecord(value)) return null;
  const { id, pageId, locator, quote, contents, tags, group } = value;
  const color = parseRgb(value.color);
  if (
    !isUint(id) ||
    !isUint(pageId) ||
    color === null ||
    typeof locator !== 'string' ||
    locator.length > 2 * PAGE_LABEL_MAX ||
    typeof quote !== 'string' ||
    quote.length > QUOTE_UNITS_MAX ||
    typeof contents !== 'string' ||
    contents.length > CONTENTS_UNITS_MAX ||
    !Array.isArray(tags) ||
    !(group === null || (typeof group === 'string' && group.length > 0 && group.length <= GROUP_UNITS_MAX))
  )
    return null;
  return { id, pageId, locator, quote, contents, tags: parseTagNames(tags), group, color };
}

/** Validates the answer of `list_citations`: at most 20 000. `null` if it is not a list of citations. */
export function parseCitationList(value: unknown): CitationInfo[] | null {
  if (!Array.isArray(value) || value.length > CITATIONS_MAX) return null;
  const list: CitationInfo[] = [];
  for (const item of value as unknown[]) {
    const info = parseCitationInfo(item);
    if (info === null) return null;
    list.push(info);
  }
  return list;
}

export const CITATION_STYLES = ['apa7', 'mla9', 'chicago17AuthorDate', 'dinIso690'] as const;
export type CitationStyle = (typeof CITATION_STYLES)[number];

/** `txt`, `html` and `md` are written from the blocks; `ris` and `bib` from the stored record (the blocks must then be empty). */
export const CITATION_FILE_FORMATS = ['txt', 'html', 'md', 'ris', 'bib'] as const;
export type CitationFileFormat = (typeof CITATION_FILE_FORMATS)[number];

/** A piece of text in one face. */
export interface Run {
  text: string;
  italic: boolean;
}

/** One paragraph of formatted text (at most 64 runs of at most 4 000 characters). Plain text: Rust escapes it for the file format. */
export interface StyledBlock {
  runs: readonly Run[];
}

/** Whether `blocks` are within what `save_citation_list` takes; the backend checks again. */
export function fitsCitationExport(blocks: readonly StyledBlock[]): boolean {
  return (
    blocks.length <= CITATION_EXPORT_BLOCKS_MAX &&
    blocks.every(
      (block) =>
        block.runs.length <= STYLED_RUNS_MAX && block.runs.every((run) => run.text.length <= STYLED_RUN_CHARS_MAX),
    )
  );
}

/**
 * Makes one citation of each draft as one undo step (`citation.create`); the quote is read by the backend from the page text. A
 * selection across pages is one draft per page, and the backend gives them one group. Rejects with `invalid_argument` (`citation`) when
 * a draft has no text, `limit_exceeded` (`citation`) over 64 drafts, and `read_only` when the document forbids edits.
 */
export async function createCitations(docId: number, drafts: readonly CitationDraft[]): Promise<ChangeSet> {
  const changes = parseChangeSet(await call<unknown>('create_citations', { docId, drafts }));
  if (changes === null) throw toAppError(null);
  return changes;
}

/** The citations of the document in page order, then position. The first call reads the page labels, so it can take a moment. */
export async function listCitations(docId: number): Promise<CitationInfo[]> {
  const list = parseCitationList(await call<unknown>('list_citations', { docId }));
  if (list === null) throw toAppError(null);
  return list;
}

/** The record of the document, merged from the user's edit, XMP, Info and page 1. Change it with `setBibliography` (undoable). */
export async function getBibliography(docId: number): Promise<BibliographyInfo> {
  const info = parseBibliographyInfo(await call<unknown>('get_bibliography', { docId }));
  if (info === null) throw toAppError(null);
  return info;
}

/** The document command that sets the record (`bibliography.set`), one undo step; `changes.doc` has `bibliography`. */
export type SetBibliographyCommand = { type: 'setBibliography'; record: BibRecord };

/** Sets the record as one undo step; the next save writes it. */
export function setBibliography(docId: number, record: BibRecord): Promise<ChangeSet> {
  return applyCommand(docId, { type: 'setBibliography', record });
}

/**
 * Saves the list to a file the user picks in a native dialog (`save_citation_list`). Resolves to `false` if the dialog was cancelled.
 * `ris` and `bib` hold the reference only: pass no blocks.
 */
export async function saveCitationList(
  docId: number,
  format: CitationFileFormat,
  blocks: readonly StyledBlock[],
  style: CitationStyle,
): Promise<boolean> {
  const saved = await call<unknown>('save_citation_list', { docId, format, blocks, style });
  if (typeof saved !== 'boolean') throw toAppError(null);
  return saved;
}
