import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import { historyOf, useAnnotations } from '../stores/annotations';
import { useDocuments } from '../stores/documents';
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
  const zoom = useView.getState().byDoc[docId]?.zoom ?? DEFAULT_ZOOM;
  const history = historyOf(useAnnotations.getState(), docId);
  return {
    hasDocument: true,
    zoomAtMin: zoom <= MIN_ZOOM,
    zoomAtMax: zoom >= MAX_ZOOM,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  };
}
