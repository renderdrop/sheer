import type { DocumentInfo } from '../../api/documents';
import type { PageSize } from '../../api/render';
import { renderCache } from '../../engine/renderCache';
import { renderScheduler } from '../../engine/renderScheduler';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import type { Viewport } from './layout';
import { publishViewRect } from './scrollBridge';
import { useViewer } from './useViewer';

/** Test helpers (not imported by app code) for the viewer's stores, which tests fill without going through the backend API. */

const viewerInitial = useViewer.getState();

/** `count` pages of the same size in points. */
export function sizes(count: number, size: PageSize = [612, 792]): PageSize[] {
  return Array.from({ length: count }, () => size);
}

/**
 * Opens a document as the backend reporting it opened would: it is registered, has a view and has its page sizes (the real sizes by
 * default, a list of `count` pages of US Letter). The viewport is the canvas's measured size, which jsdom never reports.
 */
export function showDocument(
  info: DocumentInfo,
  options: { sizes?: readonly PageSize[]; viewport?: Viewport } = {},
): void {
  renderCache.admit(info.id);
  useView.getState().open(info.id, info.pageCount);
  useDocuments.getState().add(info);
  usePages.getState().set(info.id, options.sizes ?? sizes(info.pageCount));
  if (options.viewport !== undefined) useViewer.setState({ viewport: options.viewport });
}

/** Everything the viewer keeps, back to a window with no document. */
export function resetViewer(): void {
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
  usePages.setState({ byDoc: {}, slotsByDoc: {} });
  renderCache.clear();
  for (const docId of [1, 2, 3]) renderScheduler.dropDocument(docId);
  publishViewRect({ left: 0, top: 0, right: 0, bottom: 0 });
}
