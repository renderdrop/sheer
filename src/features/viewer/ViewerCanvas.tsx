import { animate, useReducedMotion, type AnimationPlaybackControls } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { PageSize } from '../../api/render';
import { bucketFor, planPage } from '../../engine/buckets';
import { imageKey } from '../../engine/renderCache';
import { renderScheduler } from '../../engine/renderScheduler';
import { JUMP_ANIMATE_MAX_VIEWPORTS, SPRING } from '../../lib/motion';
import { clampZoom } from '../../lib/zoom';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { DEFAULT_PAGE_SIZE, sizesFor, usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useDocView, useView } from '../../stores/view';
import { OpenClone } from './OpenClone';
import { entranceFor, finishTransition, isFresh, resolveFresh, useTransition, type SourceRect } from './openTransition';
import { Canvas } from './Canvas';
import {
  EMPTY_WINDOW,
  PageLayout,
  adjacentPages,
  centeredScroll,
  centredScrollLeft,
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
import { rotatedSizes } from './transform';
import { useFindKeys } from '../search/commands';
import { useTextCopy, useTextKeys } from '../textlayer/useTextSelection';
import { BUCKET_SETTLE_MS, PageView } from './PageView';
import { consumeJump, publishViewRect, registerScrollSource } from './scrollBridge';
import { useDevicePixelRatio } from './useDevicePixelRatio';
import { cancelZoomMotion, settleZoomMotion, useViewer } from './useViewer';
import { animationsOff, registerZoomSurface } from './zoomMotion';

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
  const drawnSizes = usePages((state) => sizesFor(state, docId, view.pageCount));
  // The view rotation turns every page: the layout is made from the sizes as they are shown, the renderer and the overlays from the drawn ones.
  const sizes = useMemo(() => rotatedSizes(drawnSizes, view.rotation), [drawnSizes, view.rotation]);
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
  const reduce = useReducedMotion() === true || animationsOff();
  /** A scroll that is animated (a jump to a page, MOTION 4.8); `null` at rest. */
  const scrollAnim = useRef<AnimationPlaybackControls | null>(null);
  const [scrolling, setScrolling] = useState(false);
  const pagesLoaded = usePages((state) => docId !== null && state.byDoc[docId] !== undefined);
  const transition = useTransition((state) => state.active);
  useTextCopy();
  useFindKeys();
  useTextKeys(scrollerRef, docId);

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

  // A turn of the view crossfades the canvas (base); pages never spin. Reduced motion: at once. Another document is not a turn.
  const shownRotation = useRef({ docId, rotation: view.rotation });
  useLayoutEffect(() => {
    const before = shownRotation.current;
    shownRotation.current = { docId, rotation: view.rotation };
    if (before.docId !== docId || before.rotation === view.rotation || reduce) return;
    const content = scrollerRef.current?.querySelector<HTMLElement>('[data-canvas-content]');
    if (content === null || content === undefined) return;
    const controls = animate(content, { opacity: [0, 1] }, SPRING.base);
    controls.then(
      () => {
        content.style.opacity = '';
      },
      () => undefined,
    );
    return () => controls.stop();
  }, [docId, view.rotation, reduce]);

  // The zoom's motion scales the canvas content (MOTION 4.4): this is how it finds it.
  useEffect(
    () => registerZoomSurface(() => scrollerRef.current?.querySelector<HTMLElement>('[data-canvas-content]') ?? null),
    [],
  );

  // A scroll the user starts (wheel, touch, key, pointer) ends an animated jump: the newest intent wins.
  useEffect(() => {
    const region = scrollerRef.current;
    if (region === null) return;
    const cancel = () => {
      scrollAnim.current?.stop();
      scrollAnim.current = null;
      setScrolling(false);
    };
    const events = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
    for (const name of events) region.addEventListener(name, cancel, { passive: true });
    return () => {
      for (const name of events) region.removeEventListener(name, cancel);
      scrollAnim.current?.stop();
    };
  }, []);

  // A zoom in flight belongs to the document it started on: another document, or no canvas, ends it without a commit.
  useLayoutEffect(() => cancelZoomMotion, [docId]);

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
  // Horizontal scroll stays centred (a wide page next to narrow ones overflows) until the user scrolls sideways themselves.
  const autoCentre = useRef(true);
  const lastLeft = useRef(0);
  const track = useCallback(
    (position: ScrollPosition) => {
      if (Math.abs(position.left - lastLeft.current) > 1) autoCentre.current = false;
      lastLeft.current = position.left;
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
      // Passing pages during an animated jump are not the page the user went to.
      if (paged || scrollAnim.current !== null) return;
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
    // The committed zoom is in the DOM: the transform that carried the zoom goes in the same frame.
    settleZoomMotion();
    const changed = shownDocRef.current !== docId;
    shownDocRef.current = docId;
    if (changed) autoCentre.current = true;
    const wanted = anchor ?? (changed ? pageTopAnchor(layout, pageIndex, centeredScroll(layout)) : null);
    if (wanted !== null) {
      const target = scrollFor(layout, wanted);
      const jump = anchor !== null && consumeJump();
      scrollAnim.current?.stop();
      scrollAnim.current = null;
      region.scrollLeft = target.left;
      // A jump puts the top of a page at the top of the viewport; a zoom keeps a point wherever it was.
      const pinned = wanted.yPt === 0 && wanted.viewY === 0;
      const distance = Math.abs(target.top - region.scrollTop);
      const near = distance > 1 && distance <= JUMP_ANIMATE_MAX_VIEWPORTS * region.clientHeight;
      if (jump && !changed && !paged && !reduce && near) {
        // Up to two viewports away the jump is carried by the spring (slow); farther, and for reduced motion, it is at once.
        setScrolling(true);
        scrollAnim.current = animate(region.scrollTop, target.top, {
          ...SPRING.slow,
          onUpdate: (value: number) => {
            region.scrollTop = value;
          },
          onComplete: () => {
            scrollAnim.current = null;
            setScrolling(false);
            pinRef.current = pinned ? { page: wanted.page, top: region.scrollTop } : null;
            useView.getState().reportPage(docId, wanted.page);
          },
        });
      } else {
        region.scrollTop = target.top;
        pinRef.current = pinned ? { page: wanted.page, top: region.scrollTop } : null;
      }
      if (anchor !== null) useView.getState().consumeAnchor(docId);
    }
    if (autoCentre.current) region.scrollLeft = centredScrollLeft(region.scrollWidth, region.clientWidth);
    lastLeft.current = region.scrollLeft;
    track({ left: region.scrollLeft, top: region.scrollTop });
    // `pageIndex` is only read for a document that has just come forward: a page that scrolling reports is not a reason to run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, anchor, docId, track]);

  // A document that has just opened starts at fit width, capped at 100 % (MOTION 4.4): where fit width would exceed 100 % it
  // opens at 100 % (fixed, centred), else it follows fit width. Once its page sizes and the canvas's size are known.
  useLayoutEffect(() => {
    if (docId === null || viewport === null || !pagesLoaded || !isFresh(docId)) return;
    resolveFresh(docId);
    const fitted = fitZoomFor('width', metrics, 0, viewport, gap);
    if (fitted !== null && fitted < 1 - 1e-9) useView.getState().setFit(docId, 'width', fitted, null);
    // Where fit width would exceed 100 % the document opens at exactly 100 %, fixed, whatever it was at before (the welcome document
    // included); this also ends the opening.
    else useView.getState().setZoom(docId, 1, null);
  }, [docId, viewport, pagesLoaded, metrics, gap]);

  // The clone of a drop or of a thumbnail (MOTION 4.6) flies to its page once that is laid out (and, for a jump, scrolled to).
  const [cloneTarget, setCloneTarget] = useState<{ id: number; rect: SourceRect } | null>(null);
  useEffect(() => {
    if (transition === null || transition.docId !== docId || scrolling) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollerRef.current?.querySelector<HTMLElement>(`[data-page="${transition.page + 1}"]`);
      if (element === null || element === undefined || (transition.kind === 'open' && isFresh(transition.docId)))
        return;
      const box = element.getBoundingClientRect();
      setCloneTarget({
        id: transition.id,
        rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [transition, docId, scrolling, layout, mounted]);

  // Render the pages of the neighbouring rows ahead of the turn of the page: nothing is mounted for them, so nothing else asks.
  // Like a mounted page (`PageView`) after its zoom bucket changed, they wait `BUCKET_SETTLE_MS` before they ask: a wheel zoom or a
  // held key passes through several buckets in a moment, and only the one it stops at is worth rendering. Unlike a mounted page
  // they have nothing to wait for on screen, so they always wait.
  useEffect(() => {
    if (docId === null) return;
    const timer = window.setTimeout(() => {
      for (const page of ahead) {
        const size = drawnSizes[page] ?? DEFAULT_PAGE_SIZE;
        const plan = planPage(size[0], size[1], bucket);
        const id = { docId, page, rev: 0, bucket: plan.tiled ? plan.underlayBucket : plan.bucket };
        if (renderScheduler.cache.has(imageKey(id))) continue;
        renderScheduler.request(id, 'near').catch(() => undefined);
      }
    }, BUCKET_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [docId, ahead, drawnSizes, bucket]);

  const turn = useCallback(
    (direction: 1 | -1) => (direction === 1 ? nextPage() : previousPage()),
    [nextPage, previousPage],
  );

  const clone = transition !== null && transition.docId === docId ? transition : null;
  // In page order, so the DOM is too: a selection that runs over several pages follows the document, not the order of mounting.
  const pages = [
    ...mounted.visible.map((page) => ({ page, priority: 'visible' as const })),
    ...mounted.near.map((page) => ({ page, priority: 'near' as const })),
  ].sort((a, b) => a.page - b.page);

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
          const [widthPt, heightPt]: PageSize = drawnSizes[page] ?? DEFAULT_PAGE_SIZE;
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
              entrance={page === 0 ? entranceFor(docId) : undefined}
              rotation={view.rotation}
            />
          );
        })}
      {clone !== null && (
        <OpenClone
          key={clone.id}
          source={clone.source}
          target={cloneTarget?.id === clone.id ? cloneTarget.rect : null}
          onDone={() => finishTransition(clone.id)}
        />
      )}
    </Canvas>
  );
}
