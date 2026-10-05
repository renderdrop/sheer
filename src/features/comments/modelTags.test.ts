import { describe, expect, it } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import {
  NO_FILTER,
  NO_TAG,
  activeFilterCount,
  buildThreads,
  facets,
  filterThreads,
  groupOf,
  isFiltering,
  tagCounts,
} from './model';
import { typeOf } from './typeInfo';

const summary = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'highlight',
  color: [255, 248, 77],
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  ...over,
});

const LIST = [
  summary(1, { cite: true, tags: ['Method'] }),
  summary(2, { cite: true, contents: 'my comment' }),
  summary(3, { contents: 'on text', tags: ['method', 'Idea'] }),
  summary(4, { kind: 'note', contents: 'plain' }),
  summary(5, { kind: 'note', inReplyTo: 4, contents: 'reply', tags: undefined }),
];

describe('citation type', () => {
  it('is its own group even with a comment, and has the quote icon label', () => {
    expect(groupOf(LIST[0] as AnnotationSummary)).toBe('citation');
    expect(groupOf(LIST[1] as AnnotationSummary)).toBe('citation');
    expect(groupOf(LIST[2] as AnnotationSummary)).toBe('quote');
    expect(typeOf(LIST[1] as AnnotationSummary).key).toBe('comments.group.citation');
    expect(facets(LIST).groups).toEqual(['citation', 'note', 'quote']);
  });

  it('filters by the type Citation', () => {
    const threads = buildThreads(LIST);
    const shown = filterThreads(threads, { ...NO_FILTER, groups: ['citation'] });
    expect(shown.map((th) => th.root.id)).toEqual([1, 2]);
  });
});

describe('tags filter', () => {
  const threads = buildThreads(LIST);

  it('shows the comments with any chosen tag, ignoring case', () => {
    const shown = filterThreads(threads, { ...NO_FILTER, tags: ['METHOD'] });
    expect(shown.map((th) => th.root.id)).toEqual([1, 3]);
    expect(filterThreads(threads, { ...NO_FILTER, tags: ['Idea', 'Nothing'] }).map((th) => th.root.id)).toEqual([3]);
  });

  it('shows the comments without a tag for "No tag", by the root alone', () => {
    const shown = filterThreads(threads, { ...NO_FILTER, tags: [NO_TAG] });
    expect(shown.map((th) => th.root.id)).toEqual([2, 4]);
  });

  it('combines with the type as AND between groups', () => {
    const shown = filterThreads(threads, { ...NO_FILTER, groups: ['citation'], tags: ['method'] });
    expect(shown.map((th) => th.root.id)).toEqual([1]);
  });

  it('counts as one active restriction', () => {
    expect(isFiltering({ ...NO_FILTER, tags: ['x'] })).toBe(true);
    expect(activeFilterCount({ ...NO_FILTER, tags: ['x'], groups: ['note'] })).toBe(2);
    expect(isFiltering(NO_FILTER)).toBe(false);
  });

  it('counts the tags of the comments', () => {
    const { byName, none } = tagCounts(LIST);
    expect(byName.get('method')).toBe(2);
    expect(byName.get('idea')).toBe(1);
    expect(none).toBe(2);
  });
});
