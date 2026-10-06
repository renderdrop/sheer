import { useMemo } from 'react';

import { useSlots } from '../../stores/pages';
import { pageLabelOf } from '../topbar/format';
import { EMPTY_HISTORY, useHistoryStore } from './store';

export interface HistoryInfo {
  canBack: boolean;
  canForward: boolean;
  /** The label of the page Back returns to ("4", "iv"), or `null` without history. */
  backLabel: string | null;
}

/** What the Back control shows for document `docId`: whether there is somewhere to go and which page Back returns to. */
export function useHistory(docId: number | null): HistoryInfo {
  const history = useHistoryStore((state) => (docId === null ? EMPTY_HISTORY : (state.byDoc[docId] ?? EMPTY_HISTORY)));
  const slots = useSlots(docId);
  return useMemo(() => {
    const ids = new Set(slots.map((slot) => slot.id));
    const live = (pageId: number) => slots.length === 0 || ids.has(pageId);
    const back = history.back.filter((entry) => live(entry.pageId));
    const top = back[back.length - 1];
    const position =
      top === undefined ? -1 : slots.length === 0 ? top.pageId : slots.findIndex((s) => s.id === top.pageId);
    return {
      canBack: top !== undefined,
      canForward: history.forward.some((entry) => live(entry.pageId)),
      backLabel: top === undefined ? null : pageLabelOf(slots[position]?.label, position),
    };
  }, [history, slots]);
}
