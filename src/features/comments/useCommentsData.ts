import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { useAnnotations } from '../../stores/annotations';
import { useComments } from './store';

/** A change of the annotations refreshes the list this long after the last one (typing in a note changes it per key). */
export const REFRESH_DELAY_MS = 200;

const timers = new Map<number, number>();

/** Reads the list of `docId` again after `delay`; asking again before that moves the read (the list and the margin share it). */
export function scheduleRefresh(docId: number, delay: number = REFRESH_DELAY_MS): () => void {
  const previous = timers.get(docId);
  if (previous !== undefined) window.clearTimeout(previous);
  const id = window.setTimeout(() => {
    timers.delete(docId);
    useComments.getState().load(docId);
  }, delay);
  timers.set(docId, id);
  return () => {
    if (timers.get(docId) !== id) return;
    window.clearTimeout(id);
    timers.delete(docId);
  };
}

/**
 * Keeps the comments of a document live from the change sets (the list and the margin both use it). The first read is at once: the
 * list always reads, the margin only when nothing was read yet.
 */
export function useCommentsData(docId: number | null, alwaysRead: boolean): void {
  const rev = useAnnotations((state) => (docId === null ? 0 : (state.byDoc[docId]?.rev ?? 0)));
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (docId === null) return;
    if (seen.current !== docId) {
      seen.current = docId;
      if (alwaysRead || useComments.getState().byDoc[docId] === undefined) useComments.getState().load(docId);
      return;
    }
    return scheduleRefresh(docId);
  }, [docId, rev, alwaysRead]);
}

/** The comment (root id) the pointer or the keyboard is on, in the list or in the margin: the other shows it too. */
export const useCommentHover = create<{ hovered: number | null; hover: (id: number | null) => void }>()((set) => ({
  hovered: null,
  hover: (hovered) => set({ hovered }),
}));
