import { useDocuments } from '../../stores/documents';
import { useSigcheck } from './store';

/**
 * Opens the Signatures dialog for a document, optionally scrolled to the card of one signature (`index` is the signature's index in
 * the report). Used by the File menu, the banner's Details and the seals on the page.
 */
export function openSignaturesDialog(docId: number, index?: number): void {
  // The tab of a signed version asks about the file it was opened from, while that is open (the signatures live there).
  const source = useSigcheck.getState().sources[docId];
  const target = source !== undefined && useDocuments.getState().byId[source] !== undefined ? source : docId;
  useSigcheck.getState().openDialog(target, index ?? null);
}

/** Closes the Signatures dialog. */
export function closeSignaturesDialog(): void {
  useSigcheck.getState().closeDialog();
}
