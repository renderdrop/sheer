import { describe, expect, it } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { buildRows, buildThreads, facets, filterThreads, offsetsOf, parseDate, sortThreads, windowOf } from './model';

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

describe('parseDate', () => {
  it('reads ISO 8601 and PDF dates, and nothing else', () => {
    expect(parseDate('2023-11-14T22:13:20Z')).toBe(1_700_000_000_000);
    expect(parseDate('D:20231114221320Z')).toBe(1_700_000_000_000);
    expect(parseDate("D:20231114231320+01'00'")).toBe(1_700_000_000_000);
    expect(parseDate('D:2023')).toBe(Date.UTC(2023, 0, 1));
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('threads', () => {
  it('nests replies under their root, also through other replies, oldest first', () => {
    const threads = buildThreads([
      item(1),
      item(2, { inReplyTo: 1, modified: '2024-01-02T00:00:00Z' }),
      item(3, { inReplyTo: 2, modified: '2024-01-01T00:00:00Z' }),
      item(4),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual([1, 4]);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual([3, 2]);
    expect(threads[0]?.latest).toBe(Date.parse('2024-01-02T00:00:00Z'));
  });

  it('treats a reply to something missing as a root and survives a cycle', () => {
    const threads = buildThreads([item(1, { inReplyTo: 9 }), item(2, { inReplyTo: 3 }), item(3, { inReplyTo: 2 })]);
    expect(threads.flatMap((t) => [t.root.id, ...t.replies.map((r) => r.id)]).sort()).toEqual([1, 2, 3]);
  });
});

describe('filter and sort', () => {
  const threads = buildThreads([
    item(1, { kind: 'highlight', author: 'Ann', pageId: 2, modified: '2024-01-01T00:00:00Z' }),
    item(2, { kind: 'note', author: null, pageId: 0, modified: '2024-03-01T00:00:00Z' }),
    item(3, { kind: 'note', author: 'Bob', pageId: 1, inReplyTo: 2 }),
    item(4, { kind: 'ink', author: 'Ann', pageId: 1 }),
  ]);

  it('filters by kind and author; a thread stays if any member matches', () => {
    expect(filterThreads(threads, { kinds: ['highlight'], authors: [], statuses: [] }).map((t) => t.root.id)).toEqual([
      1,
    ]);
    expect(filterThreads(threads, { kinds: [], authors: ['Bob'], statuses: [] }).map((t) => t.root.id)).toEqual([2]);
    expect(filterThreads(threads, { kinds: [], authors: [''], statuses: [] }).map((t) => t.root.id)).toEqual([2]);
    expect(filterThreads(threads, { kinds: [], authors: [], statuses: [] })).toHaveLength(3);
  });

  it('sorts by page, newest and oldest, undated last', () => {
    expect(sortThreads(threads, 'page').map((t) => t.root.id)).toEqual([2, 4, 1]);
    expect(sortThreads(threads, 'newest').map((t) => t.root.id)).toEqual([2, 1, 4]);
    expect(sortThreads(threads, 'oldest').map((t) => t.root.id)).toEqual([1, 2, 4]);
  });

  it('lists the kinds and authors present', () => {
    const all = facets(threads.flatMap((t) => [t.root, ...t.replies]));
    expect(all.kinds).toEqual(['highlight', 'note', 'ink']);
    expect(all.authors).toEqual(['', 'Ann', 'Bob']);
  });
});

describe('status', () => {
  it('is the state of the newest review reply; review replies are not text replies', () => {
    const threads = buildThreads([
      item(1),
      item(2, { inReplyTo: 1, state: 'completed', modified: '2024-01-01T00:00:00Z' }),
      item(3, { inReplyTo: 1, contents: 'text', modified: '2024-01-02T00:00:00Z' }),
      item(4),
      item(5, { inReplyTo: 4, state: 'accepted', modified: '2024-01-01T00:00:00Z' }),
      item(6, { inReplyTo: 4, state: 'none', modified: '2024-01-02T00:00:00Z' }),
    ]);
    expect(threads.map((t) => t.status)).toEqual(['resolved', 'open']);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual([3]);
    expect(filterThreads(threads, { kinds: [], authors: [], statuses: ['resolved'] }).map((t) => t.root.id)).toEqual([
      1,
    ]);
  });
});

describe('rows', () => {
  const threads = sortThreads(
    buildThreads([item(1, { pageId: 0 }), item(2, { pageId: 0, inReplyTo: 1 }), item(3, { pageId: 4 })]),
    'page',
  );

  it('has a header per page and a card per thread', () => {
    expect(buildRows(threads, 'page').map((r) => r.key)).toEqual(['g0', 'a1', 'g4', 'a3']);
    expect(buildRows(threads, 'newest').some((r) => r.type === 'group')).toBe(false);
  });

  it('windows the rows by their offsets', () => {
    const rows = buildRows(threads, 'page');
    const offsets = offsetsOf(rows, (row) => (row.type === 'group' ? 24 : 64));
    expect(offsets).toEqual([0, 24, 88, 112, 176]);
    expect(windowOf(offsets, 0, 100, 0)).toEqual({ first: 0, last: 2 });
    expect(windowOf(offsets, 0, 0, 0)).toBeNull();
    expect(windowOf([0], 0, 100, 0)).toBeNull();
  });
});

describe('mark and signature summaries (F11)', () => {
  const threads = buildThreads([item(1, { kind: 'mark' }), item(2, { kind: 'signature', author: 'Ann' }), item(3)]);

  it('lists their kinds as filter facets', () => {
    expect(facets([item(1, { kind: 'mark' }), item(2, { kind: 'signature' })]).kinds).toEqual(['mark', 'signature']);
  });

  it('filters by those kinds', () => {
    expect(filterThreads(threads, { kinds: ['signature'], authors: [], statuses: [] }).map((t) => t.root.id)).toEqual([
      2,
    ]);
    expect(
      filterThreads(threads, { kinds: ['mark', 'signature'], authors: [], statuses: [] }).map((t) => t.root.id),
    ).toEqual([1, 2]);
  });

  it('keeps authorless marks out of an author filter', () => {
    expect(filterThreads(threads, { kinds: ['mark'], authors: ['Ann'], statuses: [] })).toEqual([]);
  });
});
