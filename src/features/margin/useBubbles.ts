import { useMemo } from 'react';

import { useComments } from '../comments/store';
import type { Thread } from '../comments/model';
import { useCommentsData } from '../comments/useCommentsData';

/**
 * Whether a thread has a bubble in the margin (DESIGN 3.5 B9): comment text or replies; a citation always has one (DESIGN 3.7 C3). A text comment's own text is not a bubble
 * (it is on the page), and a comment that cannot be edited by this app (`opaque`) has none either.
 */
export function hasBubble(thread: Thread): boolean {
  const { root } = thread;
  if (root.cite !== undefined) return true;
  if (root.kind === 'freeText' || root.kind === 'opaque') return false;
  return root.contents.trim() !== '' || thread.replies.length > 0;
}

/** The threads that have a bubble, in the list's order; empty until the comments of the document are read. */
export function useBubbleThreads(docId: number | null): readonly Thread[] {
  useCommentsData(docId, false);
  const entry = useComments((state) => (docId === null ? undefined : state.byDoc[docId]));
  const threads = entry?.status === 'ready' ? entry.threads : undefined;
  return useMemo(() => (threads === undefined ? [] : threads.filter(hasBubble)), [threads]);
}
