import { selectActiveId, useDocuments } from '../../stores/documents';
import { DEFAULT_PAGE_SIZE, positionOf, sizesFor, usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { quadBox, boxToView, totalRotation, unrotatedSize } from '../viewer/transform';
import { loadLayer } from '../textlayer/cache';
import { fileRotationOf, hasFileRotation } from '../viewer/fileRotation';
import { useViewer } from '../viewer/useViewer';
import { useSearch, type Hit } from './store';

/** The y of a hit's first quad in the page as the view shows it (page rotation and view rotation applied), in points. */
export function hitTopInView(docId: number, hit: Hit): number {
  const view = useView.getState().byDoc[docId];
  const first = hit.quads[0];
  if (view === undefined || first === undefined) return 0;
  const sizes = sizesFor(usePages.getState(), docId, view.pageCount);
  // A hit names its page by id; the sizes are in the order of the pages.
  const drawn = sizes[positionOf(docId, hit.page) ?? hit.page] ?? DEFAULT_PAGE_SIZE;
  const file = fileRotationOf(docId, hit.page);
  const page = unrotatedSize(drawn, file);
  return boxToView(quadBox(first), page, totalRotation(file, view.rotation)).y;
}

/** Scrolls the canvas to a hit: the hit's line lands at the canvas's top padding (MOTION 4.8). Focus stays where it is. */
export function jumpToHit(docId: number, hit: Hit): void {
  jumpToken += 1;
  const token = jumpToken;
  const go = () => {
    const position = positionOf(docId, hit.page);
    if (position !== null) useViewer.getState().goToPoint(position, hitTopInView(docId, hit));
  };
  if (hasFileRotation(docId, hit.page)) {
    go();
    return;
  }
  // The page's own rotation arrives with its text; the line is not placed before it is known. A newer jump replaces this one.
  void loadLayer(docId, hit.page).then(() => {
    if (token === jumpToken) go();
  });
}

let jumpToken = 0;

/** Moves to the next or the previous hit of the active document, wrapping, and shows it. */
export function stepHit(direction: 1 | -1): void {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null) return;
  const hit = useSearch.getState().step(docId, direction);
  if (hit !== null) jumpToHit(docId, hit);
}
