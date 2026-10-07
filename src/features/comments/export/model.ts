import type { AnnotationSummary } from '../../../api/annotations';
import type { BibRecord, CitationInfo, CitationStyle } from '../../../api/citations';
import type {
  CommentCitationLine,
  CommentExportFormat,
  CommentExportInclude,
  CommentExportOptions,
} from '../../../api/commentExport';
import type { PageSelection } from '../../../api/pageSelection';
import { formatShortCitation } from '../../citations/format';
import { fullNote, shortNote } from '../../citations/format/german';
import type { Lang } from '../../citations/format/text';
import { filterThreads, type Filter, type Status, type Thread, type TypeGroup } from '../model';

/**
 * The comment export dialog as pure data (DESIGN 3.16): the draft the form edits, its start from the panel's filter, the count the
 * dialog shows live, the options the backend takes and the citation lines in the chosen style (DESIGN 3.17 DZ-AC 9).
 */

/** The six types of the Include grid (DESIGN 3.16 E2); a signature is never exported. */
export const INCLUDE_KEYS = ['quote', 'note', 'highlight', 'citation', 'drawing', 'shape'] as const;
export type IncludeKey = (typeof INCLUDE_KEYS)[number];

export type ExportStatus = 'all' | 'open' | 'resolved';
export type ExportPages = 'all' | 'current' | 'range';

export interface Draft {
  include: Readonly<Record<IncludeKey, boolean>>;
  /** Authors to take (`''` is "no author"); empty is all. */
  authors: readonly string[];
  /** Tags to take (`''` is "untagged"); empty is all. */
  tags: readonly string[];
  pages: ExportPages;
  from: number;
  to: number;
  status: ExportStatus;
  format: CommentExportFormat;
}

export const FORMAT_KEY = 'sheer.commentExport.format';

/** The format of the last export (first run: PDF). */
export function storedFormat(): CommentExportFormat {
  try {
    return globalThis.localStorage?.getItem(FORMAT_KEY) === 'markdown' ? 'markdown' : 'pdf';
  } catch {
    return 'pdf';
  }
}

export function storeFormat(format: CommentExportFormat): void {
  try {
    globalThis.localStorage?.setItem(FORMAT_KEY, format);
  } catch {
    // Not remembered; harmless.
  }
}

const ALL_ON: Readonly<Record<IncludeKey, boolean>> = {
  quote: true,
  note: true,
  highlight: true,
  citation: true,
  drawing: true,
  shape: true,
};

const clampPage = (value: number, pageCount: number): number =>
  Math.min(Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1)), Math.max(1, pageCount));

/**
 * The draft that starts from the panel's filter (CE-AC 2). Changing the draft never changes the panel. A filter on status that the
 * export cannot say (accepted, rejected, several) exports all.
 */
export function draftFromFilter(
  filter: Filter,
  current: number,
  pageCount: number,
  format: CommentExportFormat,
): Draft {
  const groups = filter.groups ?? [];
  const include =
    groups.length === 0
      ? ALL_ON
      : (Object.fromEntries(INCLUDE_KEYS.map((key) => [key, groups.includes(key as TypeGroup)])) as Record<
          IncludeKey,
          boolean
        >);
  const only = filter.statuses.length === 1 ? filter.statuses[0] : undefined;
  const status: ExportStatus = only === 'open' ? 'open' : only === 'resolved' ? 'resolved' : 'all';
  const range = filter.pages ?? null;
  const from = clampPage(range === null ? current : Math.min(range.from, range.to), pageCount);
  const to = clampPage(range === null ? current : Math.max(range.from, range.to), pageCount);
  const pages: ExportPages = range === null ? 'all' : from === current && to === current ? 'current' : 'range';
  return {
    include,
    authors: [...filter.authors],
    tags: [...(filter.tags ?? [])],
    pages,
    from: pages === 'range' ? from : current,
    to: pages === 'range' ? to : current,
    status,
    format,
  };
}

export const noneIncluded = (draft: Draft): boolean => INCLUDE_KEYS.every((key) => !draft.include[key]);

/**
 * The types the backend takes: it has one `comments` bucket for text comments and notes (and stamps), so either box takes both.
 * The count uses the same buckets, so what it says is what the file holds.
 */
export function includeOf(draft: Draft): CommentExportInclude[] {
  const out: CommentExportInclude[] = [];
  if (draft.include.quote || draft.include.note) out.push('comments', 'stamps');
  if (draft.include.highlight) out.push('highlights');
  if (draft.include.citation) out.push('citations');
  if (draft.include.shape) out.push('shapes');
  if (draft.include.drawing) out.push('drawings');
  return out;
}

/** The type groups the export takes (the buckets of `includeOf`). */
function groupsOf(draft: Draft): TypeGroup[] {
  const groups: TypeGroup[] = [];
  if (draft.include.quote || draft.include.note) groups.push('quote', 'note');
  if (draft.include.highlight) groups.push('highlight');
  if (draft.include.citation) groups.push('citation');
  if (draft.include.shape) groups.push('shape');
  if (draft.include.drawing) groups.push('drawing');
  return groups;
}

/** The comments filter the draft means (`current` is the page the reader is on, 1-based). */
export function filterOf(draft: Draft, current: number): Filter {
  const range =
    draft.pages === 'all'
      ? null
      : draft.pages === 'current'
        ? { from: current, to: current }
        : { from: Math.min(draft.from, draft.to), to: Math.max(draft.from, draft.to) };
  return {
    kinds: [],
    authors: draft.authors,
    statuses: draft.status === 'all' ? [] : [draft.status as Status],
    groups: groupsOf(draft),
    tags: draft.tags,
    pages: range,
  };
}

/** The threads the export takes; a signature never, whatever the filter says. */
export function exportThreads(
  threads: readonly Thread[],
  draft: Draft,
  current: number,
  pageNumberOf: (pageId: number) => number,
): Thread[] {
  if (noneIncluded(draft)) return [];
  return filterThreads(threads, filterOf(draft, current), pageNumberOf).filter(
    (thread) => thread.root.kind !== 'signature',
  );
}

export interface ExportCount {
  items: number;
  pages: number;
}

export function countOf(threads: readonly Thread[], pageNumberOf: (pageId: number) => number): ExportCount {
  return { items: threads.length, pages: new Set(threads.map((t) => pageNumberOf(t.root.pageId))).size };
}

/** How many annotations the export could ever take: the menu and the button are off with none (CE-AC 1). */
export function exportableCount(summaries: readonly AnnotationSummary[]): number {
  return summaries.filter((s) => s.state === undefined && s.inReplyTo === null && s.kind !== 'signature').length;
}

export function pagesOf(draft: Draft, currentPageId: number | null): PageSelection {
  if (draft.pages === 'all' || (draft.pages === 'current' && currentPageId === null)) return { type: 'all' };
  if (draft.pages === 'current') return { type: 'current', pageId: currentPageId as number };
  const from = Math.min(draft.from, draft.to);
  const to = Math.max(draft.from, draft.to);
  return { type: 'ranges', text: from === to ? `${from}` : `${from}-${to}` };
}

/** The options of `export_comments`. */
export function optionsOf(
  draft: Draft,
  lang: Lang,
  currentPageId: number | null,
  citationLines: readonly CommentCitationLine[],
): CommentExportOptions {
  return {
    format: draft.format,
    include: includeOf(draft),
    pages: pagesOf(draft, currentPageId),
    lang,
    ...(draft.authors.length > 0 ? { authors: draft.authors } : {}),
    ...(draft.tags.length > 0 ? { tags: draft.tags } : {}),
    status: draft.status,
    citationLines,
  };
}

const clean = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const withStop = (text: string): string => (/[.?!…]$/u.test(text) ? text : `${text}.`);

function joinLocators(locators: readonly string[]): string {
  const distinct = locators.filter((loc, i) => loc !== '' && locators.indexOf(loc) === i);
  const first = distinct[0];
  const last = distinct[distinct.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? first : `${first}–${last}`;
}

/**
 * The citation lines of the exported citations in the chosen style (DESIGN 3.17 Z3). `citations` come in reading order and only
 * those of the export are given. Each group is one line with the joined locator and stands for every annotation of the group. The
 * Deutsche Zitierweise gives the first entry its full note and the others the short note; the other styles give the short citation.
 */
export function citationLinesFor(
  record: BibRecord,
  citations: readonly CitationInfo[],
  style: CitationStyle,
  lang: Lang,
): CommentCitationLine[] {
  const entries: { ids: number[]; locators: string[] }[] = [];
  const byGroup = new Map<string, (typeof entries)[number]>();
  for (const citation of citations) {
    let entry = citation.group === null ? undefined : byGroup.get(citation.group);
    if (entry === undefined) {
      entry = { ids: [], locators: [] };
      entries.push(entry);
      if (citation.group !== null) byGroup.set(citation.group, entry);
    }
    entry.ids.push(citation.id);
    entry.locators.push(clean(citation.locator));
  }
  const lines: CommentCitationLine[] = [];
  entries.forEach((entry, index) => {
    const locator = joinLocators(entry.locators);
    const text =
      style === 'germanNotes'
        ? index === 0
          ? fullNote(record, locator, lang)
              .map((run) => run.text)
              .join('')
          : withStop(shortNote(record, locator, lang))
        : formatShortCitation(record, locator, style, lang);
    for (const id of entry.ids) lines.push({ id, text });
  });
  return lines;
}
