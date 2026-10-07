import { describe, expect, it } from 'vitest';

import type { AnnotationSummary } from '../../../api/annotations';
import { emptyBibRecord, type BibRecord, type CitationInfo } from '../../../api/citations';
import { NO_FILTER, buildThreads } from '../model';
import {
  citationLinesFor,
  countOf,
  draftFromFilter,
  exportThreads,
  exportableCount,
  includeOf,
  noneIncluded,
  optionsOf,
  type Draft,
} from './model';

const item = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'note',
  color: [255, 235, 0],
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  ...over,
});

const list = [
  item(1, { kind: 'highlight', author: 'Ann', pageId: 0 }),
  item(2, { kind: 'note', contents: 'why?', author: 'Bob', pageId: 1 }),
  item(3, { kind: 'ink', pageId: 2 }),
  item(4, { kind: 'rect', author: 'Ann', pageId: 2 }),
  item(5, { kind: 'signature', author: 'Cy', pageId: 3 }),
  item(6, { kind: 'note', contents: 'done', author: 'Bob', pageId: 3 }),
  item(7, { kind: 'note', inReplyTo: 6, state: 'completed' }),
];
const threads = buildThreads(list);
const pageOf = (pageId: number) => pageId + 1;
const start = (filter = NO_FILTER): Draft => draftFromFilter(filter, 2, 10, 'pdf');
const ids = (draft: Draft = start()) => exportThreads(threads, draft, 2, pageOf).map((t) => t.root.id);

describe('the draft starts from the panel filter', () => {
  it('takes every type of an empty filter, drawings and shapes included', () => {
    const draft = start();
    expect(noneIncluded(draft)).toBe(false);
    expect(draft.include.drawing && draft.include.shape).toBe(true);
    expect(draft.pages).toBe('all');
    expect(draft.status).toBe('all');
  });

  it('takes the types, authors, tags, status and pages of the filter', () => {
    const draft = start({
      ...NO_FILTER,
      groups: ['highlight', 'note'],
      authors: ['Ann'],
      tags: ['a'],
      statuses: ['resolved'],
      pages: { from: 2, to: 5 },
    });
    expect(draft.include).toMatchObject({ highlight: true, note: true, drawing: false, shape: false, quote: false });
    expect(draft.authors).toEqual(['Ann']);
    expect(draft.tags).toEqual(['a']);
    expect(draft.status).toBe('resolved');
    expect([draft.pages, draft.from, draft.to]).toEqual(['range', 2, 5]);
  });

  it('knows the current page, and an unsayable status exports all', () => {
    expect(start({ ...NO_FILTER, pages: { from: 2, to: 2 } }).pages).toBe('current');
    expect(start({ ...NO_FILTER, statuses: ['accepted'] }).status).toBe('all');
    expect(start({ ...NO_FILTER, statuses: ['open', 'resolved'] }).status).toBe('all');
  });

  it('clamps a range to the page count and remembers the format', () => {
    const draft = draftFromFilter({ ...NO_FILTER, pages: { from: 4, to: 99 } }, 1, 10, 'markdown');
    expect([draft.from, draft.to, draft.format]).toEqual([4, 10, 'markdown']);
  });
});

describe('the count and the empty state', () => {
  it('never takes a signature or a review reply, and counts items and pages', () => {
    expect(ids()).toEqual([1, 2, 3, 4, 6]);
    expect(countOf(exportThreads(threads, start(), 2, pageOf), pageOf)).toEqual({ items: 5, pages: 4 });
  });

  it('follows type, author, status and page', () => {
    const base = start();
    expect(ids({ ...base, include: { ...base.include, drawing: false, shape: false } })).toEqual([1, 2, 6]);
    expect(ids({ ...base, authors: ['Ann'] })).toEqual([1, 4]);
    expect(ids({ ...base, status: 'resolved' })).toEqual([6]);
    expect(ids({ ...base, pages: 'current' })).toEqual([2]);
    expect(ids({ ...base, pages: 'range', from: 3, to: 4 })).toEqual([3, 4, 6]);
  });

  it('is empty with no type checked', () => {
    const none: Draft = {
      ...start(),
      include: { quote: false, note: false, highlight: false, citation: false, drawing: false, shape: false },
    };
    expect(noneIncluded(none)).toBe(true);
    expect(ids(none)).toEqual([]);
  });

  it('counts the annotations the export could ever take', () => {
    expect(exportableCount(list)).toBe(5);
    expect(exportableCount([item(1, { kind: 'signature' })])).toBe(0);
    expect(exportableCount([])).toBe(0);
  });
});

describe('the options for the backend', () => {
  it('maps the boxes to the backend types and leaves absent filters out', () => {
    const base = start();
    const draft: Draft = { ...base, include: { ...base.include, quote: false, shape: false } };
    expect(includeOf(draft)).toEqual(['comments', 'stamps', 'highlights', 'citations', 'drawings']);
    const options = optionsOf(draft, 'de', 7, [{ id: 1, text: 'x' }]);
    expect(options).toMatchObject({ format: 'pdf', lang: 'de', status: 'all', pages: { type: 'all' } });
    expect(options.authors).toBeUndefined();
    expect(options.tags).toBeUndefined();
    expect(options.citationLines).toEqual([{ id: 1, text: 'x' }]);
  });

  it('sends authors, tags and the page choice', () => {
    const draft: Draft = { ...start(), authors: ['', 'Ann'], tags: ['a'], pages: 'range', from: 5, to: 2 };
    expect(optionsOf(draft, 'en', 7, [])).toMatchObject({
      authors: ['', 'Ann'],
      tags: ['a'],
      pages: { type: 'ranges', text: '2-5' },
    });
    expect(optionsOf({ ...draft, pages: 'current' }, 'en', 7, []).pages).toEqual({ type: 'current', pageId: 7 });
    expect(optionsOf({ ...draft, pages: 'current' }, 'en', null, []).pages).toEqual({ type: 'all' });
  });
});

describe('the citation lines follow the chosen style', () => {
  const record: BibRecord = {
    ...emptyBibRecord(),
    kind: 'book',
    authors: [{ family: 'Müller', given: 'Hans' }],
    title: 'Digitale Lesekultur. Eine Einführung',
    year: '2021',
    publisher: 'Beispielverlag',
    place: 'Berlin',
  };
  const cite = (id: number, locator: string, group: string | null = null): CitationInfo => ({
    id,
    pageId: id,
    locator,
    quote: 'q',
    contents: '',
    tags: [],
    group,
    color: [255, 235, 0],
  });

  it('gives the Deutsche Zitierweise a full note first and short notes after it', () => {
    const lines = citationLinesFor(record, [cite(1, '12'), cite(2, '14')], 'germanNotes', 'de');
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[0]?.text).toContain('Müller, Hans: Digitale Lesekultur');
    expect(lines[0]?.text).toMatch(/S\. 12\.$/);
    expect(lines[1]?.text).toBe('Müller, Digitale Lesekultur, S. 14.');
  });

  it('gives the other styles the short citation', () => {
    const lines = citationLinesFor(record, [cite(1, '12'), cite(2, '14')], 'apa7', 'en');
    expect(lines[0]?.text).toBe('(Müller, 2021, p. 12)');
    expect(lines[1]?.text).toBe('(Müller, 2021, p. 14)');
  });

  it('makes a group across pages one line with the joined locator for every member', () => {
    const lines = citationLinesFor(
      record,
      [cite(1, '12', 'g'), cite(2, '13', 'g'), cite(3, '20')],
      'germanNotes',
      'de',
    );
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(lines[0]?.text).toContain('S. 12–13.');
    expect(lines[1]?.text).toBe(lines[0]?.text);
    expect(lines[2]?.text).toBe('Müller, Digitale Lesekultur, S. 20.');
  });
});
