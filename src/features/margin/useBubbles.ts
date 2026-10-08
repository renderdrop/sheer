import { useMemo } from 'react';

import { useComments } from '../comments/store';
import type { Thread } from '../comments/model';
import { useCommentsData } from '../comments/useCommentsData';
import { marginShowsEdits } from './store';

/**
 * Whether a thread has a bubble in the margin (DESIGN 3.5 B9): comment text or replies; a citation always has one (DESIGN 3.7 C3). A text comment's own text is not a bubble
 * (it is on the page), and a comment that cannot be edited by this app (`opaque`) has none either. The comment that is being written
 * right now (`writingId`, F19.24) has its bubble before it has any text.
 */
export function hasBubble(thread: Thread, writingId: number | null = null): boolean {
  const { root } = thread;
  if (root.cite !== undefined) return true;
  if (root.kind === 'freeText' || root.kind === 'opaque') return false;
  return root.id === writingId || root.contents.trim() !== '' || thread.replies.length > 0;
}

/** The threads that have a bubble, in the list's order; empty until the comments of the document are read. */
export function useBubbleThreads(docId: number | null): readonly Thread[] {
  useCommentsData(docId, false);
  const entry = useComments((state) => (docId === null ? undefined : state.byDoc[docId]));
  const writing = useComments((state) => {
    const edit = docId === null ? null : state.editing[docId];
    return edit?.fresh === true && marginShowsEdits() ? edit.id : null;
  });
  const threads = entry?.status === 'ready' ? entry.threads : undefined;
  return useMemo(
    () => (threads === undefined ? [] : threads.filter((thread) => hasBubble(thread, writing))),
    [threads, writing],
  );
}
