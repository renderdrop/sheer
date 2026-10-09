import { pageNumberOf, readSlots } from '../../stores/pages';

/** The label a page is shown with in the list: the file's page label ("xii") if it defines one, else the page number. */
export function pageLabelOf(docId: number, pageId: number): string {
  const label = readSlots(docId).find((slot) => slot.id === pageId)?.label;
  return label !== null && label !== undefined && label.trim() !== '' ? label : String(pageNumberOf(docId, pageId));
}

/** The labels of several pages (a comment over a group, F20.7), comma separated, in the given order. */
export function pageListOf(docId: number, pageIds: readonly number[]): string {
  return pageIds.map((pageId) => pageLabelOf(docId, pageId)).join(', ');
}
