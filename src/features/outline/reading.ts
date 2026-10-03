import { anchorAt } from '../viewer/layout';
import { layoutFor } from '../viewer/model';
import { readScroll } from '../viewer/scrollBridge';
import { useViewer } from '../viewer/useViewer';
import { tokenPx } from '../../components/tokens';
import { useView } from '../../stores/view';
import type { ReadingPosition } from './tree';

/**
 * Where the reader is in a document: the page at the top of the viewport and how far down it the reading line is (the canvas's top padding below the viewport's top, where a jump lands its target) (DESIGN 3.15).
 * Before the canvas has measured itself, the current page's top.
 */
export function readingPosition(docId: number): ReadingPosition {
  const page = useView.getState().byDoc[docId]?.pageIndex ?? 0;
  const layout = layoutFor(docId, useViewer.getState().viewport);
  const anchor = layout === null ? null : anchorAt(layout, readScroll(), 0, tokenPx('--space-3', 24));
  return anchor === null ? { page, y: 0 } : { page: anchor.page, y: Math.max(0, anchor.yPt) };
}
