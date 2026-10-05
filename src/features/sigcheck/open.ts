import { useSigcheck } from './store';

/**
 * Opens the Signatures dialog for a document, optionally scrolled to the card of one signature (`index` is the signature's index in
 * the report). Used by the File menu, the banner's Details and the seals on the page.
 */
export function openSignaturesDialog(docId: number, index?: number): void {
  useSigcheck.getState().openDialog(docId, index ?? null);
}

/** Closes the Signatures dialog. */
export function closeSignaturesDialog(): void {
  useSigcheck.getState().closeDialog();
}
