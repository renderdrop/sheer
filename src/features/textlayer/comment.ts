import type { AnnotationDraft, DocCommand } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { currentAuthor } from '../comments/actions';
import { useComments } from '../comments/store';
import { defaultStyle, markupDraft } from '../annotations/create/drafts';
import { styleFor } from '../inspector/style';
import { marginShowsEdits } from '../margin/store';
import { selectionMarkupDrafts, useMultiSelection } from './multiSelection';

/**
 * The text that is selected (the live range and the ranges pinned with the primary modifier, F20.7), as the highlight drafts that
 * cover it (one per page with all that page's quads), without contents (DESIGN 3.59 section 2). Empty when nothing usable is selected.
 */
export function selectionDrafts(docId: number): AnnotationDraft[] {
  const style = { ...defaultStyle('highlight'), ...styleFor('highlight') };
  const author = currentAuthor();
  return selectionMarkupDrafts(docId, (page, quads) => {
    const draft = markupDraft('highlight', page, quads, style);
    return draft === null ? null : { ...draft, contents: '', author };
  });
}

/** One draft is one annotation; drafts on several pages are one group (F20.7, `/IRT` + `/RT /Group`); either is one undo step. */
export function createCommand(drafts: readonly AnnotationDraft[]): DocCommand | null {
  const first = drafts[0];
  if (first === undefined) return null;
  return drafts.length === 1 ? { type: 'createAnnotation', draft: first } : { type: 'createAnnotationGroup', drafts };
}

/**
 * Adds a comment to the selected text: a highlight over it with empty contents, the Comments tab open, and its card in editing (its
 * field takes the focus; cancelling takes the comment back). Resolves with the new annotation's id, `null` when nothing was made.
 */
export async function addCommentFromSelection(docId: number): Promise<number | null> {
  const drafts = selectionDrafts(docId);
  const command = createCommand(drafts);
  const first = drafts[0];
  if (command === null || first === undefined) return null;
  try {
    const changes = await useAnnotations.getState().apply(docId, command);
    useMultiSelection.getState().clear();
    const created = changes.upserted.find((annotation) => annotation.pageId === first.pageId);
    if (created === undefined) return null;
    // With the margin on, the bubble there is the one being written (focus in its field, F19.24); else the Comments panel opens
    // (it slides) and the new card is.
    if (!marginShowsEdits()) {
      const ui = useUi.getState();
      ui.setLeftPanelCollapsed(false);
      ui.setLeftPanelTab('comments');
    }
    useComments.getState().startEdit(docId, created.id, true);
    window.getSelection()?.removeAllRanges();
    useAnnotations.getState().select(docId, [created.id]);
    return created.id;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return null;
  }
}
