import { selectActiveId, useDocuments } from '../../stores/documents';
import { DEFAULT_PAGE_SIZE, sizesFor, usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { quadBox, boxToView, totalRotation, unrotatedSize } from '../viewer/transform';
import { fileRotationOf } from '../viewer/fileRotation';
import { useViewer } from '../viewer/useViewer';
import { useSearch, type Hit } from './store';

/** The y of a hit's first quad in the page as the view shows it (page rotation and view rotation applied), in points. */
export function hitTopInView(docId: number, hit: Hit): number {
  const view = useView.getState().byDoc[docId];
  const first = hit.quads[0];
  if (view === undefined || first === undefined) return 0;
  const sizes = sizesFor(usePages.getState(), docId, view.pageCount);
  const drawn = sizes[hit.page] ?? DEFAULT_PAGE_SIZE;
  const file = fileRotationOf(docId, hit.page);
  const page = unrotatedSize(drawn, file);
  return boxToView(quadBox(first), page, totalRotation(file, view.rotation)).y;
}

/** Scrolls the canvas to a hit: the hit's line lands at the canvas's top padding (MOTION 4.8). Focus stays where it is. */
export function jumpToHit(docId: number, hit: Hit): void {
  useViewer.getState().goToPoint(hit.page, hitTopInView(docId, hit));
}

/** Moves to the next or the previous hit of the active document, wrapping, and shows it. */
export function stepHit(direction: 1 | -1): void {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null) return;
  const hit = useSearch.getState().step(docId, direction);
  if (hit !== null) jumpToHit(docId, hit);
}
