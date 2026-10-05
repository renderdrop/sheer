// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { buildThreads } from '../comments/model';
import { useComments } from '../comments/store';
import { useBubbleThreads } from './useBubbles';

vi.mock('../comments/useCommentsData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comments/useCommentsData')>()),
  useCommentsData: () => undefined,
}));

const summary = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'highlight',
  color: [255, 235, 0],
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  ...over,
});

function ready(summaries: AnnotationSummary[]) {
  useComments.setState({
    byDoc: { 1: { status: 'ready', token: 1, summaries, threads: buildThreads(summaries) } },
  });
}

beforeEach(() => useComments.setState({ byDoc: {} }));

describe('useBubbleThreads', () => {
  it('has a bubble for a document with only citations, so the margin shows', () => {
    ready([summary(1, { cite: true }), summary(2)]);
    const { result } = renderHook(() => useBubbleThreads(1));
    expect(result.current.map((thread) => thread.root.id)).toEqual([1]);
  });

  it('has none for plain highlights without comments', () => {
    ready([summary(1)]);
    const { result } = renderHook(() => useBubbleThreads(1));
    expect(result.current).toEqual([]);
  });
});
