import { listCitations } from '../../../api/citations';
import type { CommentCitationLine } from '../../../api/commentExport';
import { selectActiveId, useDocuments } from '../../../stores/documents';
import { fetchBibliography } from '../../citations/bibliography';
import { getCitationStyle } from '../../citations/style';
import { NO_FILTER, type Thread } from '../model';
import { useComments } from '../store';
import { citationLinesFor } from './model';
import { useCommentExport } from './store';

/** Opens the dialog for the active tab with the panel's filter (the Comments button and File: Export comments). */
export function openCommentExport(docId?: number): void {
  const id = docId ?? selectActiveId(useDocuments.getState());
  if (id === null) return;
  const comments = useComments.getState();
  if (comments.byDoc[id] === undefined) comments.load(id);
  useCommentExport.getState().openDialog({ docId: id, filter: comments.views[id]?.filter ?? NO_FILTER });
}

export function closeCommentExport(): void {
  useCommentExport.getState().openDialog(null);
}

/**
 * The citation lines for the citations of `threads`, in the style the reader chose (DESIGN 3.17 DZ-AC 9). Nothing is read for an
 * export without a citation. A failed read gives no lines (Rust then uses its own short form).
 */
export async function citationLinesOf(
  docId: number,
  threads: readonly Thread[],
  lang: 'en' | 'de',
): Promise<CommentCitationLine[]> {
  const wanted = new Set(threads.filter((thread) => thread.root.cite === true).map((thread) => thread.root.id));
  if (wanted.size === 0) return [];
  try {
    const [{ record }, citations] = await Promise.all([fetchBibliography(docId), listCitations(docId)]);
    // A group across pages is one entry: its other members come along for the joined locator.
    const groups = new Set(citations.filter((c) => wanted.has(c.id) && c.group !== null).map((c) => c.group));
    const taken = citations.filter((c) => wanted.has(c.id) || (c.group !== null && groups.has(c.group)));
    return citationLinesFor(record, taken, getCitationStyle(), lang);
  } catch {
    return [];
  }
}
