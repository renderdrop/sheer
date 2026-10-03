import { toAppError } from '../../api/errors';
import { saveDocument, saveDocumentAs, type SaveResult } from '../../api/save';
import { renderCache } from '../../engine/renderCache';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useSave } from './state';

/** Whether closing the tab of `docId` has to ask first: it has changes that are not saved, and it is not the welcome document. */
export function needsSavePrompt(docId: number): boolean {
  const document = useDocuments.getState().byId[docId];
  if (document === undefined || document.kind === 'welcome') return false;
  return isDirty(useAnnotations.getState(), docId);
}

/** What a save changed: the annotations are clean, the document may have another name, and the pages are drawn again from the new file. */
function adopt(docId: number, result: SaveResult): void {
  useAnnotations.getState().applyChanges(docId, result.changes);
  useDocuments.setState((state) => ({ byId: { ...state.byId, [docId]: result.document } }));
  // The file was loaded again: the images were drawn from the old one, and the overlay no longer draws the annotations that are clean.
  renderCache.dropDocument(docId);
  renderCache.admit(docId);
}

/**
 * Saves document `docId`: in place (primary+S), or through the Save As dialog (primary+Shift+S, and for a document that cannot be
 * written in place: the welcome document, or one the backend answers `read_only` for). Resolves to whether the document was saved;
 * a cancelled dialog is `false`, a failure shows the banner and is `false` (DESIGN 3.27: errors never toast).
 */
export async function saveNow(docId: number, as = false): Promise<boolean> {
  const save = useSave.getState();
  if (useSave.getState().saving[docId] === true) return false;
  save.setSaving(docId, true);
  try {
    const welcome = useDocuments.getState().byId[docId]?.kind === 'welcome';
    let result: SaveResult | null;
    if (as || welcome) {
      result = await saveDocumentAs(docId);
    } else {
      try {
        result = await saveDocument(docId);
      } catch (caught) {
        if (toAppError(caught).code !== 'read_only') throw caught;
        result = await saveDocumentAs(docId);
      }
    }
    if (result === null) return false;
    adopt(docId, result);
    return true;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return false;
  } finally {
    useSave.getState().setSaving(docId, false);
  }
}

/** Save or Save As for the active document. */
export function saveActive(as = false): void {
  const docId = useDocuments.getState().activeId;
  if (docId !== null) void saveNow(docId, as);
}
