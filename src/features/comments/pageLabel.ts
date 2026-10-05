import { pageNumberOf, readSlots } from '../../stores/pages';

/** The label a page is shown with in the list: the file's page label ("xii") if it defines one, else the page number. */
export function pageLabelOf(docId: number, pageId: number): string {
  const label = readSlots(docId).find((slot) => slot.id === pageId)?.label;
  return label !== null && label !== undefined && label.trim() !== '' ? label : String(pageNumberOf(docId, pageId));
}
