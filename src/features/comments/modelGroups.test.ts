import { describe, expect, it } from 'vitest';

import { parseAnnotationSummaries, type AnnotationSummary } from '../../api/annotations';
import { buildThreads, tagCounts, threadIds, threadPages } from './model';

const KEY = '0123456789abcdef';

const item = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'highlight',
  color: [255, 235, 0],
  contents: 'why',
  author: null,
  modified: null,
  inReplyTo: null,
  ...over,
});

describe('comment groups (F20.7)', () => {
  it('shows a group as one comment on all its pages, its replies included', () => {
    const threads = buildThreads([
      item(1, { group: KEY }),
      item(2, { pageId: 0 }),
      item(3, { pageId: 2, group: KEY }),
      item(4, { pageId: 2, kind: 'note', inReplyTo: 3, contents: 'reply' }),
      item(5, { pageId: 4, group: KEY }),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual([1, 2]);
    const [group] = threads;
    expect(group?.members.map((m) => m.id)).toEqual([3, 5]);
    expect(group?.replies.map((r) => r.id)).toEqual([4]);
    expect(threadPages(group!)).toEqual([0, 2, 4]);
    // Deleting the comment takes every member, as one command.
    expect(threadIds(group!)).toEqual([1, 3, 5, 4]);
    expect(tagCounts([item(1, { group: KEY }), item(3, { group: KEY })]).none).toBe(1);
  });

  it('treats a group of one as a comment on its own', () => {
    const [thread] = buildThreads([item(1, { group: KEY })]);
    expect(thread?.members).toEqual([]);
  });

  it('reads the group key of the backend and drops one that is not a key', () => {
    const wire = (group: unknown) => ({ ...item(1), group });
    expect(parseAnnotationSummaries([wire(KEY)])?.[0]?.group).toBe(KEY);
    expect(parseAnnotationSummaries([wire('<b>x</b>')])?.[0]?.group).toBeUndefined();
  });
});
