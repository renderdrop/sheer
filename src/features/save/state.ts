import { create } from 'zustand';

/**
 * Saving and closing with changes (DESIGN 3.27). `saving` holds the documents a save is running for (the status bar says
 * "Saving…"); `prompt` is the document whose tab was closed with unsaved changes, for which the dialog asks.
 */
export interface SaveState {
  saving: Readonly<Record<number, true>>;
  prompt: number | null;
  setSaving: (docId: number, saving: boolean) => void;
  setPrompt: (docId: number | null) => void;
}

export const useSave = create<SaveState>()((set) => ({
  saving: {},
  prompt: null,
  setSaving: (docId, saving) =>
    set((state) => {
      if ((state.saving[docId] === true) === saving) return state;
      const next = { ...state.saving } as Record<number, true>;
      if (saving) next[docId] = true;
      else delete next[docId];
      return { saving: next };
    }),
  setPrompt: (docId) => set((state) => (state.prompt === docId ? state : { prompt: docId })),
}));
