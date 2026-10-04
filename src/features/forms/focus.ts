import { selectActiveId, useDocuments } from '../../stores/documents';
import { positionOf } from '../../stores/pages';
import { useViewer } from '../viewer/useViewer';
import { firstEmptyStop, neighbourStop, tabStops, type Stop } from './model';
import { useForms } from './store';

/** A focus request older than this is forgotten: the page it waited for arrived too late to be what the user meant. */
export const FOCUS_REQUEST_TTL_MS = 2000;

/** The tab stops of a document now (fields in tab order, pages in order). */
export function stopsOf(docId: number): Stop[] {
  const form = useForms.getState().byDoc[docId];
  return form === undefined ? [] : tabStops(form.fields, (pageId) => positionOf(docId, pageId));
}

/** The control of a widget if its page is mounted. */
export function controlOf(key: string): HTMLElement | null {
  const widget = document.querySelector(`[data-form-widget="${CSS.escape(key)}"]`);
  return widget?.querySelector<HTMLElement>('[data-form-control]') ?? null;
}

/**
 * Moves focus to a stop. The browser scrolls the control into view (nearest); a page that is not mounted is scrolled to first and
 * the widget takes the focus when it mounts (`useFocusRequest`).
 */
export function focusStop(docId: number, stop: Stop): void {
  const control = controlOf(stop.key);
  if (control !== null) {
    control.focus();
    return;
  }
  useForms.getState().requestFocus(docId, stop.key);
  useViewer.getState().goToPage(stop.position);
}

/** Tab and Shift+Tab: the neighbour of the field in the order. `false`: there is none, so Tab leaves the canvas. */
export function tabFrom(docId: number, field: number, direction: 1 | -1): boolean {
  const next = neighbourStop(stopsOf(docId), field, direction);
  if (next === null) return false;
  focusStop(docId, next);
  return true;
}

/** Go to first empty field (the form banner's button, DESIGN 3.58): focus it. `false` when every field is filled in (or there are none). */
export function focusFirstEmpty(docId: number): boolean {
  const stop = firstEmptyStop(stopsOf(docId));
  if (stop === null) return false;
  focusStop(docId, stop);
  return true;
}

/** The active document's id, for the actions. */
export function activeDocId(): number | null {
  return selectActiveId(useDocuments.getState());
}
