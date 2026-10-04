import { describe, expect, it } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import {
  NO_FILTER,
  activeFilterCount,
  buildThreads,
  facets,
  filterThreads,
  firstLine,
  groupOf,
  sortThreads,
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

describe('filter by type group, page and status; sort by author', () => {
  const list = [
    item(1, { kind: 'highlight', contents: '', author: 'Ann', pageId: 0, modified: '2024-01-03T00:00:00Z' }),
    item(2, { kind: 'highlight', contents: 'why?', author: 'Bob', pageId: 1, modified: '2024-01-01T00:00:00Z' }),
    item(3, { kind: 'ink', author: null, pageId: 2, modified: '2024-01-02T00:00:00Z' }),
    item(4, { kind: 'rect', author: 'Ann', pageId: 2 }),
    item(5, { kind: 'signature', author: 'Cy', pageId: 3 }),
    item(6, { kind: 'note', contents: 'n', author: 'Bob', pageId: 3 }),
    item(7, { kind: 'note', inReplyTo: 6, state: 'completed' }),
  ];
  const threads = buildThreads(list);
  const ids = (filter = NO_FILTER) => filterThreads(threads, filter).map((t) => t.root.id);

  it('folds kinds into the six types, a text markup with text being a quote', () => {
    expect(list.slice(0, 6).map(groupOf)).toEqual(['highlight', 'quote', 'drawing', 'shape', 'signature', 'note']);
    expect(facets(list).groups).toEqual(['highlight', 'note', 'drawing', 'shape', 'signature', 'quote']);
  });

  it('combines type, author, page range and status', () => {
    expect(ids({ ...NO_FILTER, groups: ['shape', 'drawing'] })).toEqual([3, 4]);
    expect(ids({ ...NO_FILTER, groups: ['shape', 'drawing'], authors: ['Ann'] })).toEqual([4]);
    expect(ids({ ...NO_FILTER, pages: { from: 2, to: 3 } })).toEqual([2, 3, 4]);
    // The page numbers are 1-based; a reversed range reads the same.
    expect(ids({ ...NO_FILTER, pages: { from: 3, to: 2 } })).toEqual([2, 3, 4]);
    expect(ids({ ...NO_FILTER, pages: { from: 4, to: 4 }, statuses: ['resolved'] })).toEqual([6]);
    expect(ids({ ...NO_FILTER, statuses: ['open'], groups: ['note'] })).toEqual([]);
  });

  it('maps page ids to numbers through the caller', () => {
    const byPosition = (pageId: number) => 10 - pageId;
    expect(
      filterThreads(threads, { ...NO_FILTER, pages: { from: 9, to: 9 } }, byPosition).map((t) => t.root.id),
    ).toEqual([2]);
  });

  it('counts the kinds of restriction that are on', () => {
    expect(activeFilterCount(NO_FILTER)).toBe(0);
    expect(
      activeFilterCount({ ...NO_FILTER, groups: ['note', 'shape'], authors: ['Ann'], pages: { from: 1, to: 1 } }),
    ).toBe(3);
  });

  it('sorts by author A to Z with no author last, and by date newest first', () => {
    expect(sortThreads(threads, 'author').map((t) => t.root.id)).toEqual([1, 4, 2, 6, 5, 3]);
    expect(sortThreads(threads, 'newest').map((t) => t.root.id)).toEqual([1, 3, 2, 4, 5, 6]);
  });

  it('takes the text as the first line, else the quote, else nothing', () => {
    expect(firstLine('  hello ', 'quote')).toBe('hello');
    expect(firstLine('', 'quote')).toBe('quote');
    expect(firstLine(' ', null)).toBe('');
  });
});
