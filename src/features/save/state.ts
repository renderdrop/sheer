import { create } from 'zustand';

import type { AppError } from '../../api/errors';

/** What the user chose in the dialog that asks about a tab (or, when quitting, a document) with unsaved changes. */
export type PromptAnswer = 'save' | 'discard' | 'cancel';

/** How long "Saved" stays in the status bar after a save. */
export const SAVED_HINT_MS = 2500;

/** The quit walks the edited documents one by one: this is the `i`-th (1-based) of `n`. */
export interface QuitProgress {
  i: number;
  n: number;
}

/**
 * Saving and closing with changes (DESIGN 3.27). `saving` holds the documents a save is running for (the status bar says
 * "Saving…"); `saved` the document that was saved a moment ago ("Saved"); `prompt` is the document whose tab was closed (or that the
 * quit is at) with unsaved changes, for which the dialog asks; `quit` is set while the quit walks the documents, and `answer` is the
 * waiting quit's way to hear what the user chose. `overwrite` is the document whose file changed on disk and a save asks to replace it.
 */
export interface SaveState {
  saving: Readonly<Record<number, true>>;
  saved: number | null;
  /** Documents whose last save failed, with the error the status button shows as its tooltip (DESIGN 3.5 B1). */
  failed: Readonly<Record<number, AppError>>;
  prompt: number | null;
  quit: QuitProgress | null;
  answer: ((answer: PromptAnswer) => void) | null;
  overwrite: { docId: number; resolve: (confirmed: boolean) => void } | null;
  /** The document whose protected file a save asks to rewrite in full (ADR-047). */
  rewrite: { docId: number; resolve: (confirmed: boolean) => void } | null;
  setSaving: (docId: number, saving: boolean) => void;
  /** Records (or, with `null`, clears) the failure of the last save of `docId`. */
  setFailed: (docId: number, error: AppError | null) => void;
  /** Shows "Saved" for `SAVED_HINT_MS`. */
  markSaved: (docId: number) => void;
  setPrompt: (docId: number | null) => void;
  setQuit: (quit: QuitProgress | null, answer?: ((answer: PromptAnswer) => void) | null) => void;
  setOverwrite: (overwrite: SaveState['overwrite']) => void;
  setRewrite: (rewrite: SaveState['rewrite']) => void;
}

let savedTimer: ReturnType<typeof setTimeout> | undefined;

export const useSave = create<SaveState>()((set) => ({
  saving: {},
  saved: null,
  failed: {},
  prompt: null,
  quit: null,
  answer: null,
  overwrite: null,
  rewrite: null,
  setSaving: (docId, saving) =>
    set((state) => {
      if ((state.saving[docId] === true) === saving) return state;
      const next = { ...state.saving } as Record<number, true>;
      if (saving) next[docId] = true;
      else delete next[docId];
      return { saving: next };
    }),
  setFailed: (docId, error) =>
    set((state) => {
      if ((state.failed[docId] ?? null) === error) return state;
      const next = { ...state.failed } as Record<number, AppError>;
      if (error === null) delete next[docId];
      else next[docId] = error;
      return { failed: next };
    }),
  markSaved: (docId) => {
    clearTimeout(savedTimer);
    set({ saved: docId });
    savedTimer = setTimeout(() => set({ saved: null }), SAVED_HINT_MS);
  },
  setPrompt: (docId) => set((state) => (state.prompt === docId ? state : { prompt: docId })),
  setQuit: (quit, answer = null) => set({ quit, answer }),
  setOverwrite: (overwrite) => set({ overwrite }),
  setRewrite: (rewrite) => set({ rewrite }),
}));
