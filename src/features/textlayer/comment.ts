import type { AnnotationDraft, DocCommand } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { useAnnotations } from '../../stores/annotations';
import { pageIdAt, positionOf } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { currentAuthor } from '../comments/actions';
import { useComments } from '../comments/store';
import { defaultStyle, markupDraft } from '../annotations/create/drafts';
import { quadsForOffsets } from '../annotations/create/markup';
import { styleFor } from '../inspector/style';
import { marginShowsEdits } from '../margin/store';
import { peekLayer } from './cache';
import { resolveBoundary } from './selection';

const LABEL_CREATE = 'annotation.create';
/** The most pages one selection comments on, as for a highlight. */
const MAX_PAGES = 50;

/**
 * The text that is selected, as the highlight drafts that cover it (one per page), without contents (DESIGN 3.59 section 2). Empty
 * when nothing usable is selected.
 */
export function selectionDrafts(docId: number): AnnotationDraft[] {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  const a = resolveBoundary(range.startContainer, range.startOffset);
  const b = resolveBoundary(range.endContainer, range.endOffset);
  if (a === null || b === null) return [];
  const aPosition = positionOf(docId, a.page);
  const bPosition = positionOf(docId, b.page);
  if (aPosition === null || bPosition === null) return [];
  const forward = aPosition < bPosition || (aPosition === bPosition && a.index <= b.index);
  const [start, end] = forward ? [a, b] : [b, a];
  const [startPosition, endPosition] = forward ? [aPosition, bPosition] : [bPosition, aPosition];
  const style = { ...defaultStyle('highlight'), ...styleFor('highlight') };
  const author = currentAuthor();
  const drafts: AnnotationDraft[] = [];
  for (let position = startPosition; position <= endPosition && position <= startPosition + MAX_PAGES; position += 1) {
    const page = pageIdAt(docId, position);
    if (page === null) continue;
    const layer = peekLayer(docId, page);
    if (layer === undefined) continue;
    const from = page === start.page ? start.index : 0;
    const to = page === end.page ? end.index : layer.text.length;
    const draft = markupDraft('highlight', page, quadsForOffsets(layer, from, to), style);
    if (draft !== null) drafts.push({ ...draft, contents: '', author });
  }
  return drafts;
}

/**
 * Adds a comment to the selected text: a highlight over it with empty contents, the Comments tab open, and its card in editing (its
 * field takes the focus; cancelling takes the comment back). Resolves with the new annotation's id, `null` when nothing was made.
 */
export async function addCommentFromSelection(docId: number): Promise<number | null> {
  const drafts = selectionDrafts(docId);
  const first = drafts[0];
  if (first === undefined) return null;
  const command: DocCommand =
    drafts.length === 1
      ? { type: 'createAnnotation', draft: first }
      : {
          type: 'batch',
          label: LABEL_CREATE,
          commands: drafts.map((draft) => ({ type: 'createAnnotation', draft })),
        };
  try {
    const changes = await useAnnotations.getState().apply(docId, command);
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
