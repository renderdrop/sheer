import { tokenPx } from '../../components/tokens';
import { sizesFor, usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { PageLayout, metricsFor, type Metrics, type ScrollMode, type Viewport } from './layout';
import { rotatedSizes, type Rotation } from './transform';

/** The space between pages: `--space-6`, 24 px (DESIGN v2 3.2). */
const PAGE_GAP_FALLBACK = 24;
let gap: number | null = null;

/** The space between pages in px, read from the design token once. */
export function pageGap(): number {
  if (gap !== null) return gap;
  if (typeof document === 'undefined') return PAGE_GAP_FALLBACK;
  const read = tokenPx('--space-6', PAGE_GAP_FALLBACK);
  gap = read;
  return read;
}

/** The padding of the scroll region around the content: `--canvas-gutter` (24 px), which is `p-canvas-gutter` on the region. */
const CANVAS_PADDING_FALLBACK = 24;
let padding: number | null = null;

/** The padding around the content in px, read from the design token once. */
export function canvasPadding(): number {
  if (padding !== null) return padding;
  if (typeof document === 'undefined') return CANVAS_PADDING_FALLBACK;
  const read = tokenPx('--canvas-gutter', CANVAS_PADDING_FALLBACK);
  padding = read;
  return read;
}

/** What differs from the document's own view when a layout is asked for (a zoom or a mode that is about to be set). */
export interface LayoutOverrides {
  zoom?: number;
  mode?: ScrollMode;
  /** A view rotation that is about to be set. */
  rotation?: Rotation;
  current?: number;
}

/**
 * The layout of an open document as the stores have it now, in `viewport`; `null` while the canvas has not measured itself
 * (`viewport` is `null`) and for a document that is not open. The canvas builds its own from the same inputs.
 */
export function layoutFor(
  docId: number,
  viewport: Viewport | null,
  overrides: LayoutOverrides = {},
): PageLayout | null {
  const view = useView.getState().byDoc[docId];
  if (view === undefined || viewport === null) return null;
  // The view rotation turns every page, so the layout is made from the sizes as they are shown.
  const sizes = rotatedSizes(sizesFor(usePages.getState(), docId, view.pageCount), overrides.rotation ?? view.rotation);
  const mode = overrides.mode ?? view.scrollMode;
  return new PageLayout(metricsFor(sizes, mode), {
    zoom: overrides.zoom ?? view.zoom,
    gap: pageGap(),
    viewport,
    current: overrides.current ?? view.pageIndex,
  });
}

/** What the page sizes of an open document say about its layout in `mode` (the document's own by default); `null` if it is not open. */
export function metricsOfDocument(docId: number, mode?: ScrollMode, rotation?: Rotation): Metrics | null {
  const view = useView.getState().byDoc[docId];
  if (view === undefined) return null;
  const sizes = rotatedSizes(sizesFor(usePages.getState(), docId, view.pageCount), rotation ?? view.rotation);
  return metricsFor(sizes, mode ?? view.scrollMode);
}
