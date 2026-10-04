import { create } from 'zustand';

import type { RecoveryEntry, RecoveryId } from '../../api/recovery';

/** What the recovery banner shows (DESIGN 3.50). `hidden` is "Decide later": for this session only, the records stay. */
interface RecoveryState {
  entries: readonly RecoveryEntry[];
  hidden: boolean;
  /** Records being restored (spinner, `aria-busy`). */
  busy: readonly RecoveryId[];
  /** Records whose restore failed (the row stays, with the alert). */
  failed: readonly RecoveryId[];
  setEntries: (entries: readonly RecoveryEntry[]) => void;
  hide: () => void;
  setBusy: (id: RecoveryId, busy: boolean) => void;
  setFailed: (id: RecoveryId, failed: boolean) => void;
  remove: (ids: readonly RecoveryId[]) => void;
  /** Puts records back (undo of a discard), newest first like the backend lists them. */
  restoreRows: (entries: readonly RecoveryEntry[]) => void;
}

const without = (list: readonly RecoveryId[], id: RecoveryId, keep: boolean): readonly RecoveryId[] => {
  const rest = list.filter((item) => item !== id);
  return keep ? [...rest, id] : rest;
};

export const useRecovery = create<RecoveryState>((set) => ({
  entries: [],
  hidden: false,
  busy: [],
  failed: [],
  setEntries: (entries) => set({ entries, hidden: false, busy: [], failed: [] }),
  hide: () => set({ hidden: true }),
  setBusy: (id, busy) => set((state) => ({ busy: without(state.busy, id, busy) })),
  setFailed: (id, failed) => set((state) => ({ failed: without(state.failed, id, failed) })),
  remove: (ids) => set((state) => ({ entries: state.entries.filter((entry) => !ids.includes(entry.id)) })),
  restoreRows: (rows) =>
    set((state) => ({
      entries: [...state.entries, ...rows.filter((row) => !state.entries.some((entry) => entry.id === row.id))].sort(
        (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt),
      ),
    })),
}));
