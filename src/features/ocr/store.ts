import { create } from 'zustand';

import type { OcrCapabilities, PageClass } from '../../api/ocr';
import { useDocuments } from '../../stores/documents';

/** A recognition run in a tab (DESIGN 3.12 O3). `job` is `null` until `ocr_start` has answered. */
export interface OcrRun {
  job: number | null;
  total: number;
  done: number;
  failed: number;
  /** Stop was pressed; the run ends after its current page. */
  stopping: boolean;
}

/** The OCR dialog: for which tab, and whether Pages mode had cards selected (scope preselect, O1). */
export interface OcrDialogState {
  docId: number;
  preselectSelected: boolean;
  /** Opened by "Save as text PDF…" (F19.22): the panel puts the focus on that section. */
  textPdf?: boolean;
}

interface OcrState {
  /** `null` until `ocr_capabilities` has answered. */
  capabilities: OcrCapabilities | null;
  /** The OCR class of each page, by tab (the offer banner and the dialog counts). */
  classes: Readonly<Record<number, readonly PageClass[]>>;
  runs: Readonly<Record<number, OcrRun>>;
  /** Tabs whose offer banner was closed (tab session). */
  dismissed: Readonly<Record<number, true>>;
  dialog: OcrDialogState | null;
  setCapabilities: (capabilities: OcrCapabilities) => void;
  setClasses: (docId: number, classes: readonly PageClass[]) => void;
  setRun: (docId: number, run: OcrRun | null) => void;
  patchRun: (docId: number, patch: Partial<OcrRun>) => void;
  dismiss: (docId: number) => void;
  openDialog: (state: OcrDialogState | null) => void;
  forget: (docId: number) => void;
}

function without<Value>(record: Readonly<Record<number, Value>>, docId: number): Record<number, Value> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => Number(key) !== docId));
}

export const useOcr = create<OcrState>()((set) => ({
  capabilities: null,
  classes: {},
  runs: {},
  dismissed: {},
  dialog: null,
  setCapabilities: (capabilities) => set({ capabilities }),
  setClasses: (docId, classes) => set((state) => ({ classes: { ...state.classes, [docId]: classes } })),
  setRun: (docId, run) =>
    set((state) => ({ runs: run === null ? without(state.runs, docId) : { ...state.runs, [docId]: run } })),
  patchRun: (docId, patch) =>
    set((state) => {
      const run = state.runs[docId];
      return run === undefined ? state : { runs: { ...state.runs, [docId]: { ...run, ...patch } } };
    }),
  dismiss: (docId) => set((state) => ({ dismissed: { ...state.dismissed, [docId]: true } })),
  openDialog: (dialog) => set({ dialog }),
  forget: (docId) =>
    set((state) => ({
      classes: without(state.classes, docId),
      runs: without(state.runs, docId),
      dismissed: without(state.dismissed, docId),
    })),
}));

// A closed tab takes its classes, its run and its dismissal with it.
useDocuments.subscribe((state, previous) => {
  for (const key of Object.keys(previous.byId)) {
    const docId = Number(key);
    if (state.byId[docId] === undefined) useOcr.getState().forget(docId);
  }
});

/** Whether a run is going on in the tab (not reactive; for guards and actions). */
export function isOcrBusy(docId: number | null | undefined): boolean {
  return docId !== null && docId !== undefined && useOcr.getState().runs[docId] !== undefined;
}

/** `isOcrBusy`, followed. */
export function useOcrBusy(docId: number | null | undefined): boolean {
  return useOcr((state) => docId !== null && docId !== undefined && state.runs[docId] !== undefined);
}
