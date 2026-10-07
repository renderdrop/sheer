import { create } from 'zustand';

import type { Filter } from '../model';

/** The open comment export dialog: for which tab, and the panel's filter it starts from (DESIGN 3.16 E2). */
export interface CommentExportDialogState {
  docId: number;
  filter: Filter;
}

interface CommentExportStore {
  dialog: CommentExportDialogState | null;
  openDialog: (state: CommentExportDialogState | null) => void;
}

export const useCommentExport = create<CommentExportStore>()((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
}));
