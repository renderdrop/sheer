import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { PageSize } from '../../api/render';
import { bucketFor, planPage } from '../../engine/buckets';
import { imageKey } from '../../engine/renderCache';
import { renderScheduler } from '../../engine/renderScheduler';
import { clampZoom } from '../../lib/zoom';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { DEFAULT_PAGE_SIZE, sizesFor, usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useDocView, useView } from '../../stores/view';
import { Canvas } from './Canvas';
import {
  EMPTY_WINDOW,
  PageLayout,
  adjacentPages,
  centeredScroll,
  fitZoomFor,
  isPaged,
  metricsFor,
  pageTopAnchor,
  pageWindow,
  scrollFor,
  type PageWindow,
  type ScrollPosition,
  type Viewport,
} from './layout';
import { canvasPadding, pageGap } from './model';
import { BUCKET_SETTLE_MS, PageView } from './PageView';
import { publishViewRect, registerScrollSource } from './scrollBridge';
import { useDevicePixelRatio } from './useDevicePixelRatio';
import { useViewer } from './useViewer';

function sameList(x: readonly number[], y: readonly number[]): boolean {
  return x.length === y.length && x.every((page, i) => page === y[i]);
}

function sameWindow(a: PageWindow, b: PageWindow): boolean {
  return sameList(a.visible, b.visible) && sameList(a.near, b.near);
}

/** The page a "go to page" or a change of mode put at the top of the viewport, until the user scrolls away from it. */
interface Pin {
  page: number;
  top: number;
}

/**
 * The canvas with the open document's state (ADR-002 §5): it lays the document out from the sizes of its pages, mounts only the pages
 * near the viewport (those on screen and one viewport's height around them, at most 24), tells the render scheduler which they are,
 * scrolls to where a zoom, a change of mode or a jump to a page asks the document to be, and reports the page that the scroll
 * position is on.
 *
 * It follows the zoom, the mode and the current page of the open document, and the display's pixel ratio; the scroll position it
 * keeps to itself, and re-renders only when the set of mounted pages changes, not for every scroll event.
 */
export function ViewerCanvas({ style }: { style?: CSSProperties }) {
  const docId = useDocuments(selectActiveId);
  const view = useDocView(docId);
  const sizes = usePages((state) => sizesFor(state, docId, view.pageCount));
  const viewport = useViewer((state) => state.viewport);
  const busy = useViewer((state) => state.rendering);
  const setViewport = useViewer((state) => state.setViewport);
  const zoomByWheel = useViewer((state) => state.zoomByWheel);
  const zoomBy = useViewer((state) => state.zoomBy);
  const nextPage = useViewer((state) => state.nextPage);
  const previousPage = useViewer((state) => state.previousPage);
  const dropActive = useUi((state) => state.dropHover);
  const ratio = useDevicePixelRatio();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const setRegion = useCallback((region: HTMLDivElement | null) => {
    scrollerRef.current = region;
  }, []);
  const pinRef = useRef<Pin | null>(null);

  const { zoom, scrollMode, pageIndex, pageCount, anchor } = view;
  const paged = isPaged(scrollMode);
  const gap = pageGap();
  const metrics = useMemo(() => metricsFor(sizes, scrollMode), [sizes, scrollMode]);
  // Only a paged mode shows what the current page is in; continuous scrolling lays out every page whatever the current one is.
  const current = paged ? pageIndex : 0;
  const layout = useMemo(
    () => (viewport === null || pageCount === 0 ? null : new PageLayout(metrics, { zoom, gap, viewport, current })),
    [metrics, zoom, gap, viewport, current, pageCount],
  );
  const content = useMemo(() => (layout === null ? null : { width: layout.width, height: layout.height }), [layout]);
  const bucket = bucketFor(zoom, ratio);
  // While the grid slides a panel the content keeps its zoom and a fit follows as a transform (MOTION 3): the scale it would have.
  const { fit } = view;
  const fitScale = useCallback(
    (size: Viewport): number | null => {
      if (fit === 'none') return null;
      const target = fitZoomFor(fit, metrics, pageIndex, size, gap);
      return target === null ? null : clampZoom(target) / zoom;
    },
    [fit, metrics, pageIndex, gap, zoom],
  );

  // The actions that need the scroll position (a zoom step from the keyboard) read it from here.
  useEffect(
    () =>
      registerScrollSource(() => {
        const region = scrollerRef.current;
        return region === null ? { left: 0, top: 0 } : { left: region.scrollLeft, top: region.scrollTop };
      }),
    [],
  );

  // The pages to mount, from the scroll position. State, so the canvas renders when the set changes and not for every scroll event.
  // In a paged mode the rows next to the shown one are rendered ahead of a turn of the page: nothing is mounted for them.
  const [mounted, setMounted] = useState<PageWindow>(EMPTY_WINDOW);
  const ahead = useMemo(() => (layout === null ? [] : adjacentPages(layout)), [layout]);
  const told = useRef<{ docId: number | null; window: PageWindow; ahead: readonly number[] }>({
    docId: null,
    window: EMPTY_WINDOW,
    ahead: [],
  });
  const track = useCallback(
    (position: ScrollPosition) => {
      if (layout === null || docId === null) return;
      // What is on screen is the whole of the region: the content's origin is `padding` px inside it, so the content shows from
      // `scroll - padding` over the region's full height, which is the content box and the padding above and below it.
      const pad = canvasPadding();
      const top = position.top - pad;
      const left = position.left - pad;
      const { width, height } = layout.viewport;
      publishViewRect({ left, top, right: left + width + 2 * pad, bottom: top + height + 2 * pad });
      const next = pageWindow(layout, top, height + 2 * pad);
      const last = told.current;
      if (last.docId !== docId || !sameWindow(last.window, next) || !sameList(last.ahead, ahead)) {
        told.current = { docId, window: next, ahead };
        setMounted(next);
        // The scheduler hears of it now, before the new pages mount and ask for their images: those renders then carry this
        // generation, and a hint that was made for the old window can never cancel them. Nothing on screen is nothing to tell.
        if (next.visible.length > 0) renderScheduler.updateViewport(docId, next.visible, [...next.near, ...ahead]);
      }
      if (paged) return;
      // The page the status bar shows follows the scroll position, except right after a jump to a page: the last page cannot
      // be scrolled to the top, and would then be reported as the one before it.
      let page = layout.currentPageAt(top, height + 2 * pad);
      const pin = pinRef.current;
      if (pin !== null) {
        if (Math.abs(position.top - pin.top) < 1) page = pin.page;
        else pinRef.current = null;
      }
      useView.getState().reportPage(docId, page);
    },
    [layout, docId, paged, ahead],
  );

  // A zoom, a change of mode or a jump to a page left an anchor: now that the layout is in the DOM, scroll there. Then follow the position.
  // Another document is shown from the top of the page it was left at (the first for a new one), not at the scroll position of the last.
  const shownDocRef = useRef(docId);
  useLayoutEffect(() => {
    const region = scrollerRef.current;
    if (region === null || layout === null || docId === null) return;
    const changed = shownDocRef.current !== docId;
    shownDocRef.current = docId;
    const wanted = anchor ?? (changed ? pageTopAnchor(layout, pageIndex, centeredScroll(layout)) : null);
    if (wanted !== null) {
      const target = scrollFor(layout, wanted);
      region.scrollLeft = target.left;
      region.scrollTop = target.top;
      // A jump puts the top of a page at the top of the viewport; a zoom keeps a point wherever it was.
      pinRef.current = wanted.yPt === 0 && wanted.viewY === 0 ? { page: wanted.page, top: region.scrollTop } : null;
      if (anchor !== null) useView.getState().consumeAnchor(docId);
    }
    track({ left: region.scrollLeft, top: region.scrollTop });
    // `pageIndex` is only read for a document that has just come forward: a page that scrolling reports is not a reason to run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, anchor, docId, track]);

  // Render the pages of the neighbouring rows ahead of the turn of the page: nothing is mounted for them, so nothing else asks.
  // Like a mounted page (`PageView`) after its zoom bucket changed, they wait `BUCKET_SETTLE_MS` before they ask: a wheel zoom or a
  // held key passes through several buckets in a moment, and only the one it stops at is worth rendering. Unlike a mounted page
  // they have nothing to wait for on screen, so they always wait.
  useEffect(() => {
    if (docId === null) return;
    const timer = window.setTimeout(() => {
      for (const page of ahead) {
        const size = sizes[page] ?? DEFAULT_PAGE_SIZE;
        const plan = planPage(size[0], size[1], bucket);
        const id = { docId, page, rev: 0, bucket: plan.tiled ? plan.underlayBucket : plan.bucket };
        if (renderScheduler.cache.has(imageKey(id))) continue;
        renderScheduler.request(id, 'near').catch(() => undefined);
      }
    }, BUCKET_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [docId, ahead, sizes, bucket]);

  const turn = useCallback(
    (direction: 1 | -1) => (direction === 1 ? nextPage() : previousPage()),
    [nextPage, previousPage],
  );

  const pages = [
    ...mounted.visible.map((page) => ({ page, priority: 'visible' as const })),
    ...mounted.near.map((page) => ({ page, priority: 'near' as const })),
  ];

  return (
    <Canvas
      style={style}
      content={content}
      pageCount={pageCount}
      busy={busy}
      onWheelZoom={zoomByWheel}
      onPinch={zoomBy}
      onScroll={track}
      onViewport={setViewport}
      fitScale={fitScale}
      paged={paged}
      onPageTurn={turn}
      onRegion={setRegion}
      dropActive={dropActive}
    >
      {layout !== null &&
        docId !== null &&
        pages.map(({ page, priority }) => {
          const box = layout.box(page);
          if (box === null) return null;
          const [widthPt, heightPt]: PageSize = sizes[page] ?? DEFAULT_PAGE_SIZE;
          // The box is a new object whenever the canvas renders: it is handed over as numbers, so that a page whose box did not
          // change is not rendered again (`PageView` is memoized).
          return (
            <PageView
              key={`${docId}:${page}`}
              docId={docId}
              pageIndex={page}
              pageCount={pageCount}
              left={box.left}
              top={box.top}
              width={box.width}
              height={box.height}
              widthPt={widthPt}
              heightPt={heightPt}
              bucket={bucket}
              priority={priority}
            />
          );
        })}
    </Canvas>
  );
}
