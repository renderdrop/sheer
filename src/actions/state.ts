import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import { historyOf, useAnnotations } from '../stores/annotations';
import { citationCount } from '../features/citations/store';
import { isSignatureLocked } from '../features/lock/useSignatureLock';
import { exportableCount } from '../features/comments/export/model';
import { useComments } from '../features/comments/store';
import { useOcr } from '../features/ocr/store';
import { selectActiveDocument, useDocuments } from '../stores/documents';
import { useView } from '../stores/view';

/**
 * What an action's `enabled` looks at. Flags and no numbers, on purpose: the toolbar builds its entries from them and must
 * not render for every zoom step or page (ADR-015), and a flag flips only at the limits. Pages are not in it for the same
 * reason; "next page" at the last page does nothing (the view stops there).
 */
export interface ActionState {
  hasDocument: boolean;
  /** The zoom is at its minimum or maximum, so the button that cannot go further is disabled. */
  zoomAtMin: boolean;
  zoomAtMax: boolean;
  /** The active document's history has a step to take back or to do again (the `annotations` store). */
  canUndo: boolean;
  canRedo: boolean;
  /**
   * The document's permissions allow printing and copying (DESIGN 3.41, 3.39). Optional so a state without them means allowed
   * (`mayPrint`, `mayCopy`); `readActionState` fills them from the active document.
   */
  canPrint?: boolean;
  canCopy?: boolean;
  /** The active document has citations (File: Copy and Save Citation List; absent: none). */
  hasCitations?: boolean;
  /** The active document has an annotation the comment export could take (DESIGN 3.16 E1); absent: not known yet, the command stays on. */
  hasExportableComments?: boolean;
  /** The active document cannot be changed (the tour's sample); absent: it can. */
  readOnly?: boolean;
  /** A certifying signature locks the active document (DESIGN 3.8 S5); absent: not locked. Every editing action reads it. */
  signatureLocked?: boolean;
  /** The active document carries signatures (Datei: Signatures…); absent: none. */
  signed?: boolean;
  /** The document's permissions allow changing it (absent: yes); Recognize text needs it (DESIGN 3.12 O4). */
  canEdit?: boolean;
  /** The recognizer reports no backend on this computer (absent: usable, or not known yet). */
  ocrUnavailable?: boolean;
  /** A text recognition run goes on in the active tab: Save, closing and page structure wait (DESIGN 3.12 O3). */
  ocrBusy?: boolean;
  /** The file has a signature field that is signed, whatever it allows (headers and footers would break it; DESIGN 3.15 HF6). */
  signedFile?: boolean;
}

/** Whether an editing action may run: there is a document and no signature locks it. */
export const mayEdit = (state: ActionState): boolean => state.hasDocument && state.signatureLocked !== true;

/** Whether Recognize text may run now (DESIGN 3.12 O4): editable, not locked, a recognizer exists, no run in this tab. */
export const mayRecognize = (state: ActionState): boolean =>
  mayEdit(state) &&
  state.readOnly !== true &&
  state.canEdit !== false &&
  state.ocrUnavailable !== true &&
  state.ocrBusy !== true;

/** Whether Headers and footers may open (DESIGN 3.15 HF6): editable, nothing signed, no run of text recognition in this tab. */
export const mayHeaderFooter = (state: ActionState): boolean =>
  mayEdit(state) &&
  state.readOnly !== true &&
  state.canEdit !== false &&
  state.signedFile !== true &&
  state.ocrBusy !== true;

/** Why Headers and footers is disabled, as a catalog key (HF6: signed, locked, no permission, OCR running); `null` when it may open. */
export function headerFooterReason(
  state: ActionState,
): 'cert.locked.tool' | 'hf.signed' | 'tool.readOnly' | 'ocr.busy' | null {
  if (!state.hasDocument) return null;
  if (state.signatureLocked === true) return 'cert.locked.tool';
  if (state.signedFile === true) return 'hf.signed';
  if (state.readOnly === true || state.canEdit === false) return 'tool.readOnly';
  if (state.ocrBusy === true) return 'ocr.busy';
  return null;
}

/** Whether the state allows printing (absent: yes). */
export const mayPrint = (state: ActionState): boolean => state.canPrint !== false;
/** Whether the state allows exporting content as images (absent: yes). */
export const mayCopy = (state: ActionState): boolean => state.canCopy !== false;

/** Whether the tab's comment list holds something to export; `undefined` while the list is not read yet. */
function exportableIn(docId: number): boolean | undefined {
  const entry = useComments.getState().byDoc[docId];
  return entry?.status === 'ready' ? exportableCount(entry.summaries) > 0 : undefined;
}

/** The state before a document is open. */
export const NO_DOCUMENT: Readonly<ActionState> = {
  hasDocument: false,
  zoomAtMin: false,
  zoomAtMax: false,
  canUndo: false,
  canRedo: false,
};

/** The state of the stores now. The key handler and the native menu read it when a command arrives. */
export function readActionState(): ActionState {
  const docId = useDocuments.getState().activeId;
  if (docId === null) return NO_DOCUMENT;
  const permissions = selectActiveDocument(useDocuments.getState())?.flags?.permissions ?? null;
  const zoom = useView.getState().byDoc[docId]?.zoom ?? DEFAULT_ZOOM;
  const history = historyOf(useAnnotations.getState(), docId);
  return {
    hasDocument: true,
    zoomAtMin: zoom <= MIN_ZOOM,
    zoomAtMax: zoom >= MAX_ZOOM,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    canPrint: permissions === null || permissions.includes('print'),
    canCopy: permissions === null || permissions.includes('copy'),
    hasCitations: citationCount(docId) > 0,
    hasExportableComments: exportableIn(docId),
    readOnly: selectActiveDocument(useDocuments.getState())?.kind === 'welcome',
    signatureLocked: isSignatureLocked(docId),
    signed: (selectActiveDocument(useDocuments.getState())?.signatureLock ?? 'none') !== 'none',
    canEdit: permissions === null || permissions.includes('edit'),
    ocrUnavailable: useOcr.getState().capabilities?.backend === 'none',
    ocrBusy: useOcr.getState().runs[docId] !== undefined,
    signedFile: selectActiveDocument(useDocuments.getState())?.flags?.signed === true,
  };
}
