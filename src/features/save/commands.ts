import { toAppError } from '../../api/errors';
import { saveDocument, saveDocumentAs, type SaveAck, type SaveResult } from '../../api/save';
import { renderCache } from '../../engine/renderCache';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { askAuthorName } from '../author/state';
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

/** Asks whether a file that changed on disk since it was opened may be replaced; resolves `true` for "Overwrite". */
function confirmOverwrite(docId: number): Promise<boolean> {
  return new Promise((resolve) => {
    // A second question for the same document (cannot happen with the single-flight guard) answers the first "no".
    useSave.getState().overwrite?.resolve(false);
    useSave.getState().setOverwrite({ docId, resolve });
  });
}

/** Whether the backend asks the user to confirm replacing a file that changed on disk. */
function isFileChanged(caught: unknown): boolean {
  const error = toAppError(caught);
  return error.code === 'needs_confirmation' && error.params?.what === 'fileChangedOnDisk';
}

/**
 * The first save of a document with annotations asks once for the author name (ADR-034) while it is empty and the prompt is
 * pending. It waits only for the user's choice (Confirm, Skip or Esc), never longer. Not asked before the settings are loaded.
 */
async function askAuthorOnce(docId: number): Promise<void> {
  const { loaded, authorName, authorPrompt } = useSettings.getState();
  if (!loaded || authorName !== '' || authorPrompt !== 'pending') return;
  const doc = useAnnotations.getState().byDoc[docId];
  if (doc === undefined || (!doc.history.dirty && Object.keys(doc.byId).length === 0)) return;
  await askAuthorName();
}
/**
 * Saves document `docId`: in place (primary+S), or through the Save As dialog (primary+Shift+S, and for a document that cannot be
 * written in place: the welcome document, or one the backend answers `read_only` for). Resolves to whether the document was saved;
 * a cancelled dialog is `false`, a failure shows the banner and is `false` (DESIGN 3.27: errors never toast). A file that changed on
 * disk asks first (a dialog, not the banner) and is saved again with the user's say.
 */
export async function saveNow(docId: number, as = false): Promise<boolean> {
  const save = useSave.getState();
  if (save.saving[docId] === true) return false;
  save.setSaving(docId, true);
  try {
    await askAuthorOnce(docId);
    const welcome = useDocuments.getState().byId[docId]?.kind === 'welcome';
    const run = async (ack?: SaveAck): Promise<SaveResult | null> => {
      if (as || welcome) return saveDocumentAs(docId, ack);
      try {
        return await saveDocument(docId, ack);
      } catch (caught) {
        if (toAppError(caught).code !== 'read_only') throw caught;
        return saveDocumentAs(docId, ack);
      }
    };
    let result: SaveResult | null;
    try {
      result = await run();
    } catch (caught) {
      if (!isFileChanged(caught)) throw caught;
      if (!(await confirmOverwrite(docId))) return false;
      result = await run({ fileChanged: true });
    }
    if (result === null) return false;
    adopt(docId, result);
    useSave.getState().markSaved(docId);
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
