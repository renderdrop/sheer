import { create } from 'zustand';

import type { AppError } from '../../api/errors';
import { toAppError } from '../../api/errors';
import { validateSignatures, type SignatureReport } from '../../api/signing';

/** The check of one document's signatures (DESIGN v1.4 S6): in the background, never blocking. */
export type CheckEntry =
  { status: 'checking' } | { status: 'ready'; report: SignatureReport } | { status: 'failed'; error: AppError };

interface SigcheckState {
  byDoc: Record<number, CheckEntry>;
  /** Documents whose banner was closed; for this session of the tab only. */
  dismissed: Record<number, true>;
  /** The Signatures dialog: the document and the signature whose card it scrolls to. */
  dialog: { docId: number; index: number | null } | null;
  /** The seal the page shows as picked by "Show on page". */
  shown: { docId: number; index: number } | null;
  begin: (docId: number) => void;
  setReport: (docId: number, report: SignatureReport) => void;
  fail: (docId: number, error: AppError) => void;
  remove: (docId: number) => void;
  dismiss: (docId: number) => void;
  openDialog: (docId: number, index: number | null) => void;
  closeDialog: () => void;
  show: (value: { docId: number; index: number } | null) => void;
}

export const useSigcheck = create<SigcheckState>()((set) => ({
  byDoc: {},
  dismissed: {},
  dialog: null,
  shown: null,
  begin: (docId) => set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'checking' } } })),
  setReport: (docId, report) => set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'ready', report } } })),
  fail: (docId, error) => set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'failed', error } } })),
  remove: (docId) =>
    set((state) => {
      const byDoc = { ...state.byDoc };
      const dismissed = { ...state.dismissed };
      delete byDoc[docId];
      delete dismissed[docId];
      return {
        byDoc,
        dismissed,
        dialog: state.dialog?.docId === docId ? null : state.dialog,
        shown: state.shown?.docId === docId ? null : state.shown,
      };
    }),
  dismiss: (docId) => set((state) => ({ dismissed: { ...state.dismissed, [docId]: true } })),
  openDialog: (docId, index) => set({ dialog: { docId, index } }),
  closeDialog: () => set({ dialog: null }),
  show: (shown) => set({ shown }),
}));

/** Documents whose check is under way, so a document is checked once however often its tab becomes active. */
const running = new Set<number>();

/** Checks the signatures of a document in the background (once; `force` checks again). Failure is kept as a state, never thrown. */
export async function checkSignatures(docId: number, force = false): Promise<void> {
  const entry = useSigcheck.getState().byDoc[docId];
  if (running.has(docId) || (entry !== undefined && !force)) return;
  running.add(docId);
  useSigcheck.getState().begin(docId);
  try {
    const report = await validateSignatures(docId);
    useSigcheck.getState().setReport(docId, report);
  } catch (error) {
    useSigcheck.getState().fail(docId, toAppError(error));
  } finally {
    running.delete(docId);
  }
}

/** Resets the store (tests). */
export function resetSigcheck(): void {
  running.clear();
  useSigcheck.setState({ byDoc: {}, dismissed: {}, dialog: null, shown: null });
}
