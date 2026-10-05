import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The one notice queue (DESIGN 3.9 Q8). Toasts, coach marks and tips are notices; at most one is visible.
 * Priority: 1 error toast, 2 coach mark (active tour), 3 info or success toast, 4 tip. Only an error preempts a visible
 * notice, which then returns to the head of the queue. Within a priority the order is first in, first out.
 */
export type NoticeKind = 'error' | 'coach' | 'info' | 'tip';

const PRIORITY: Record<NoticeKind, number> = { error: 1, coach: 2, info: 3, tip: 4 };

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** Returns `true` when the notice's context is gone (the tool was released): it is dropped instead of shown. */
  gone?: () => boolean;
}

interface NoticesState {
  visible: Notice | null;
  queue: readonly Notice[];
  /** Asks to show a notice. A notice that is already visible or queued is left where it is. */
  request: (notice: Notice) => void;
  /** The notice ended or its owner went away: it leaves the queue or the slot, and the next one comes up. */
  release: (id: string) => void;
}

/** Inserts behind every notice of the same or a higher priority. */
function insert(queue: readonly Notice[], notice: Notice): Notice[] {
  const at = queue.findIndex((other) => PRIORITY[other.kind] > PRIORITY[notice.kind]);
  const next = [...queue];
  next.splice(at < 0 ? next.length : at, 0, notice);
  return next;
}

/** The first queued notice that still has a context. */
function promote(queue: readonly Notice[]): { visible: Notice | null; queue: Notice[] } {
  const rest = [...queue];
  while (rest.length > 0) {
    const next = rest.shift();
    if (next !== undefined && next.gone?.() !== true) return { visible: next, queue: rest };
  }
  return { visible: null, queue: [] };
}

export const useNotices = create<NoticesState>()((set) => ({
  visible: null,
  queue: [],
  request: (notice) =>
    set((state) => {
      if (state.visible?.id === notice.id || state.queue.some((other) => other.id === notice.id)) return state;
      if (state.visible === null) return { visible: notice };
      if (notice.kind === 'error' && state.visible.kind !== 'error') {
        return { visible: notice, queue: [state.visible, ...state.queue] };
      }
      return { queue: insert(state.queue, notice) };
    }),
  release: (id) =>
    set((state) => {
      if (state.visible?.id === id) return promote(state.queue);
      if (!state.queue.some((other) => other.id === id)) return state;
      return { queue: state.queue.filter((other) => other.id !== id) };
    }),
}));

/** For tests: empties the queue. */
export function resetNotices(): void {
  useNotices.setState({ visible: null, queue: [] });
}

/**
 * Takes a place in the notice queue while `wanted` and returns whether the notice is the visible one. A notice that does not
 * show waits and shows when the ones before it have ended. Nothing renders while it returns `false`.
 */
export function useNoticeSlot(id: string, kind: NoticeKind, wanted: boolean): boolean {
  useEffect(() => {
    if (!wanted) return;
    useNotices.getState().request({ id, kind });
    return () => useNotices.getState().release(id);
  }, [id, kind, wanted]);
  const visible = useNotices((state) => state.visible?.id === id);
  return wanted && visible;
}
