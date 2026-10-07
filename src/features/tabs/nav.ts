import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useUi } from '../../stores/ui';
import { isOcrBusy } from '../ocr/store';
import { needsSavePrompt } from '../save/commands';
import { useSave } from '../save/state';
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
 * Closes the tab of document `id` without asking, through the viewer close (which releases everything of the document). Closing the active tab
 * selects its right neighbour, else its left one (the store rule); closing another tab leaves the active one as it is.
 */
export function forceCloseTab(id: number): void {
  const documents = useDocuments.getState();
  if (documents.byId[id] === undefined) return;
  const previous = documents.activeId;
  documents.setActive(id);
  useViewer.getState().close();
  if (previous !== null && previous !== id) useDocuments.getState().setActive(previous);
}

/**
 * Closes the tab of document `id` after asking about its changes (DESIGN 3.27): a document with changes that are not saved opens the
 * dialog (`features/save/UnsavedDialog`), which closes it with `forceCloseTab` when the user chooses to; any other closes now.
 */
export function closeTab(id: number): void {
  // A run writes into the tab: it cannot close before it ends (DESIGN 3.12 O3).
  if (isOcrBusy(id)) {
    useUi.getState().showToast({ message: translators[useLocaleStore.getState().locale]('ocr.busy'), tone: 'alert' });
    return;
  }
  if (needsSavePrompt(id)) {
    useSave.getState().setPrompt(id);
    return;
  }
  forceCloseTab(id);
}
