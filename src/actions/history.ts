import { toAppError } from '../api/errors';
import { isTextEntry } from '../lib/textEntry';
import { useAnnotations } from '../stores/annotations';
import { useDocuments } from '../stores/documents';
import { useUi } from '../stores/ui';

/**
 * Edit > Undo and Redo: takes back or does again the last step of the active document's history (the annotations store; the
 * backend owns the history, ADR-003 section 7).
 *
 * The macOS menu bar sends the command also while a text field has focus (its accelerator takes the key before the web view
 * does); the field's own history is meant then, so the editing command goes to the field. The key handler never gets here for a
 * field (`handleKeyDown` leaves text entry alone). A step that fails (the engine is busy) is reported in the banner; the replica
 * stays as it was.
 */
export function runHistoryStep(step: 'undo' | 'redo'): void {
  if (isTextEntry(document.activeElement)) {
    document.execCommand(step);
    return;
  }
  const docId = useDocuments.getState().activeId;
  if (docId === null) return;
  const store = useAnnotations.getState();
  (step === 'undo' ? store.undo(docId) : store.redo(docId)).catch((caught: unknown) => {
    useUi.getState().showBanner(toAppError(caught));
  });
}
