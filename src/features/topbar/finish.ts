import { runAction } from '../../actions/dispatch';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { saveNow } from '../save/commands';

/**
 * Fertig: saves the document, then goes back to Home (the document stays open behind it). Nothing is written for a document
 * without changes; a recovered document has no file, so it goes through Save As. A cancelled dialog or a failed save keeps the
 * editor open (the failure shows its banner).
 */
export async function finishDocument(docId: number | null): Promise<void> {
  if (docId !== null) {
    const kind = useDocuments.getState().byId[docId]?.kind;
    if (kind === 'recovered' || isDirty(useAnnotations.getState(), docId)) {
      if (!(await saveNow(docId))) return;
    }
  }
  runAction('view-home');
}
