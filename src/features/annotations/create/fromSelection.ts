import type { AnnotationDraft, DocCommand } from '../../../api/annotations';
import { useAnnotations } from '../../../stores/annotations';
import { peekLayer } from '../../textlayer/cache';
import { resolveBoundary } from '../../textlayer/selection';
import { styleFor } from '../../inspector/style';
import { defaultStyle, markupDraft } from './drafts';
import { quadsForOffsets } from './markup';

const LABEL_CREATE = 'annotation.create';

/**
 * Marks the text that is selected in the text layers (DESIGN 3.22: H with selected text marks it at once). One command, so one undo
 * step, even when the selection spans pages. Returns whether anything was marked.
 */
export async function markSelection(docId: number, kind: 'highlight' | 'underline' | 'strikeout'): Promise<boolean> {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const a = resolveBoundary(range.startContainer, range.startOffset);
  const b = resolveBoundary(range.endContainer, range.endOffset);
  if (a === null || b === null) return false;
  const [start, end] = a.page < b.page || (a.page === b.page && a.index <= b.index) ? [a, b] : [b, a];
  const style = { ...defaultStyle(kind), ...styleFor(kind) };
  const drafts: AnnotationDraft[] = [];
  for (let page = start.page; page <= end.page && page <= start.page + 50; page += 1) {
    const layer = peekLayer(docId, page);
    if (layer === undefined) continue;
    const from = page === start.page ? start.index : 0;
    const to = page === end.page ? end.index : layer.text.length;
    const draft = markupDraft(kind, page, quadsForOffsets(layer, from, to), style);
    if (draft !== null) drafts.push(draft);
  }
  const first = drafts[0];
  if (first === undefined) return false;
  const commands: DocCommand[] = drafts.map((draft) => ({ type: 'createAnnotation', draft }));
  const command: DocCommand =
    drafts.length === 1 ? { type: 'createAnnotation', draft: first } : { type: 'batch', label: LABEL_CREATE, commands };
  try {
    await useAnnotations.getState().apply(docId, command);
    return true;
  } catch {
    return false;
  }
}
