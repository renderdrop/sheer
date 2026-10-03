import type { PageCommand } from '../api/pages';
import { useAnnotations } from './annotations';
import { readSlots } from './pages';
import type { PageSlotInfo } from '../api/pages';

/**
 * Page commands as the organize UI runs them: through the document's one history (`annotations` store), which hands the page list
 * of the change set to the `pages` store. Both resolve with the list as it is after the step.
 */

/** Applies a page command; resolves to the page list after it, `null` if the command did not change the list. */
export async function applyPageCommand(docId: number, command: PageCommand): Promise<readonly PageSlotInfo[] | null> {
  const changes = await useAnnotations.getState().apply(docId, command);
  return changes.pages === null ? null : readSlots(docId);
}

/** Takes back the last step of the document's history. */
export async function undoPageStep(docId: number): Promise<void> {
  await useAnnotations.getState().undo(docId);
}
