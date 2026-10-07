import { create } from 'zustand';

import type { HeaderFooterInfo } from '../../api/headerFooter';
import type { Draft } from './model';

/** The open dialog: for which tab, what the backend said (read before opening), and a range to preselect (1-based, Pages mode). */
export interface HfDialogState {
  docId: number;
  info: HeaderFooterInfo;
  preselect: { first: number; last: number } | null;
  /** Dev surfaces start from a ready draft. */
  draft?: Draft;
}

interface HfStore {
  dialog: HfDialogState | null;
  /** Tabs with a call to the backend under way (Apply or Remove). */
  busy: Readonly<Record<number, true>>;
  openDialog: (state: HfDialogState | null) => void;
  setBusy: (docId: number, busy: boolean) => void;
}

export const useHeaderFooter = create<HfStore>()((set) => ({
  dialog: null,
  busy: {},
  openDialog: (dialog) => set({ dialog }),
  setBusy: (docId, busy) =>
    set((state) => {
      const rest = Object.fromEntries(Object.entries(state.busy).filter(([key]) => Number(key) !== docId));
      return { busy: busy ? { ...rest, [docId]: true } : rest };
    }),
}));
