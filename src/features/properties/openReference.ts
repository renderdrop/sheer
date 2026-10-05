import { create } from 'zustand';

import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';

export type PropertiesTab = 'general' | 'reference';

/** The tab an entry point asked the Document properties dialog to open on; the dialog takes it when it opens and clears it. */
export const usePropertiesTabRequest = create<{ tab: PropertiesTab | null }>()(() => ({ tab: null }));

/**
 * Opens the Document properties dialog on the Reference tab (DESIGN 3.7 C5): "Edit reference…" (C7) and "Add reference details" (C3).
 * Makes `docId` the active document first, since the dialog shows the active one. The last tab is never remembered; only the entry
 * points that name Reference open it.
 */
export function openReferenceDetails(docId: number): void {
  useDocuments.getState().setActive(docId);
  usePropertiesTabRequest.setState({ tab: 'reference' });
  useUi.getState().setPropsOpen(true);
}
