import { create } from 'zustand';

import { useDocuments } from '../../stores/documents';

/** The document whose reference record the Quellenangabe inspector edits (DESIGN §3.18 E5); `null` = closed. */
export const useReferenceInspector = create<{ docId: number | null }>()(() => ({ docId: null }));

/**
 * Opens the Quellenangabe inspector (DESIGN 3.7 C5, §3.18 E5): "Edit reference…" (C7) and "Add reference details" (C3). Makes
 * `docId` the active document first, since the inspector follows the active one.
 */
export function openReferenceDetails(docId: number): void {
  useDocuments.getState().setActive(docId);
  useReferenceInspector.setState({ docId });
}

export function closeReferenceInspector(): void {
  useReferenceInspector.setState({ docId: null });
}
