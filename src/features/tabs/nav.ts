import { useDocuments } from '../../stores/documents';
import { useViewer } from '../viewer/useViewer';

/** Makes the next (`1`) or previous (`-1`) tab the active one, wrapping around; nothing with fewer than two documents. */
export function cycleTab(step: 1 | -1): void {
  const { order, activeId, setActive } = useDocuments.getState();
  if (order.length < 2 || activeId === null) return;
  const index = order.indexOf(activeId);
  const next = order[(index + step + order.length) % order.length];
  if (next !== undefined) setActive(next);
}

/**
 * Closes the tab of document `id` through the viewer close (which releases everything of the document). Closing the active tab
 * selects its right neighbour, else its left one (the store rule); closing another tab leaves the active one as it is.
 */
export function closeTab(id: number): void {
  const documents = useDocuments.getState();
  if (documents.byId[id] === undefined) return;
  const previous = documents.activeId;
  documents.setActive(id);
  useViewer.getState().close();
  if (previous !== null && previous !== id) useDocuments.getState().setActive(previous);
}
