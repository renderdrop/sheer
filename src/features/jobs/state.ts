import { create } from 'zustand';

import { closeDocument, type DocumentInfo } from '../../api/documents';
import { useDocuments } from '../../stores/documents';

/** The modes of the split dialog (DESIGN 3.30). */
export type SplitMode = 'every' | 'ranges' | 'extract';

/** Which job surface is open. At most one; the multi-drop banner is separate and non-modal. */
export type Sheet =
  { kind: 'merge'; held: readonly DocumentInfo[] | null } | { kind: 'split'; mode: SplitMode } | { kind: 'compress' };

export interface JobsState {
  sheet: Sheet | null;
  /** Documents the backend opened for a drop of two or more files, held back until the user chooses (DESIGN 3.29). */
  drop: readonly DocumentInfo[] | null;
  setSheet: (sheet: Sheet | null) => void;
  setDrop: (drop: readonly DocumentInfo[] | null) => void;
}

export const useJobs = create<JobsState>()((set) => ({
  sheet: null,
  drop: null,
  setSheet: (sheet) => set({ sheet }),
  setDrop: (drop) => set({ drop }),
}));

/** Forgets the documents of a drop that no tab shows: the backend closes them. */
export function discardHeld(documents: readonly DocumentInfo[] | null): void {
  if (documents === null) return;
  const shown = useDocuments.getState().byId;
  for (const document of documents) {
    if (shown[document.id] === undefined) closeDocument(document.id, true).catch(() => undefined);
  }
}

/** A new drop replaces the banner of the last one; the documents of that one are dropped. */
export function holdDrop(documents: readonly DocumentInfo[]): void {
  discardHeld(useJobs.getState().drop);
  useJobs.getState().setDrop(documents);
}

export const openMerge = (): void => {
  useJobs.getState().setSheet({ kind: 'merge', held: null });
};
export const openSplit = (mode: SplitMode = 'every'): void => useJobs.getState().setSheet({ kind: 'split', mode });
export const openCompress = (): void => useJobs.getState().setSheet({ kind: 'compress' });
/** Closes the open sheet; the documents of a drop that no tab shows are closed in the backend. */
export function closeSheet(): void {
  const { sheet, setSheet } = useJobs.getState();
  if (sheet?.kind === 'merge') discardHeld(sheet.held);
  setSheet(null);
}
