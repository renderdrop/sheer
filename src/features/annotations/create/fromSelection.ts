import { useAnnotations } from '../../../stores/annotations';
import { createCommand } from '../../textlayer/comment';
import { selectionMarkupDrafts, useMultiSelection } from '../../textlayer/multiSelection';
import { styleFor } from '../../inspector/style';
import { defaultStyle, markupDraft } from './drafts';

/**
 * Marks the text that is selected in the text layers (DESIGN 3.22: H with selected text marks it at once), the ranges pinned with the
 * primary modifier included (F20.7): one annotation per page with all that page's quads, over several pages one group. One command,
 * so one undo step. Returns whether anything was marked.
 */
export async function markSelection(docId: number, kind: 'highlight' | 'underline' | 'strikeout'): Promise<boolean> {
  const style = { ...defaultStyle(kind), ...styleFor(kind) };
  const command = createCommand(selectionMarkupDrafts(docId, (page, quads) => markupDraft(kind, page, quads, style)));
  if (command === null) return false;
  try {
    await useAnnotations.getState().apply(docId, command);
    useMultiSelection.getState().clear();
    return true;
  } catch {
    return false;
  }
}
