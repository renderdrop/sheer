import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { SPRING } from '../../lib/motion';
import { DropCard } from './DropCard';
import type { ScrollPosition, Viewport } from './layout';
import { canvasPadding } from './model';
import { isLayoutAnimating, subscribeLayoutAnimating } from './scrollBridge';

/** WebKit's pinch gesture events (WKWebView, which does not turn a pinch into ctrl+wheel the way Chromium does). Not in lib.dom. */
interface GestureEvent extends UIEvent {
  /** The scale since the gesture began: 1 at its start. */
  scale: number;
  clientX: number;
  clientY: number;
}

/** Where a zoom gesture is centred: a position in the scroll region's content box, in px. */
export interface CanvasZoomFocus {
  x: number;
  y: number;
}

/**
 * Reported with the size that ends a track animation of the grid: the content point (in the content's own px) that has to appear
 * at (`viewX`, `viewY`) of the new viewport, so the layout that follows keeps what the user saw where it was (MOTION 3).
 */
export interface ViewportAnchor {
  x: number;
  y: number;
  viewX: number;
  viewY: number;
}

/** What the canvas knows at the start of a track animation. */
interface Freeze {
  /** The viewport the layout was made for, the scroll position, and the content's own width then. */
  width: number;
  height: number;
  scrollLeft: number;
  contentWidth: number;
  /** The content point under the viewport's centre: the origin of the fit's scale. */
  originX: number;
  originY: number;
}

/** After a wheel turned the page (a paged mode, scrolled to its end), the next turn waits this long: a trackpad's inertia sends wheel events for a second. */
export const PAGE_TURN_COOLDOWN_MS = 400;

export interface CanvasProps {
  /** The size of the content in px (the pages' box; never smaller than the region), `null` while there is none yet. */
  content: Viewport | null;
  /** The mounted pages, positioned in the content by themselves. */
  children?: ReactNode;
  pageCount: number;
  /** A render is in flight. */
  busy: boolean;
  /** Ctrl/Cmd+wheel (browsers report a pinch as ctrl+wheel). Needs a non-passive listener, so it is attached here. */
  onWheelZoom: (deltaY: number, deltaMode: number, focus?: CanvasZoomFocus) => void;
  /** A pinch that arrives as WebKit gesture events: the factor since the last event. */
  onPinch?: (factor: number, focus: CanvasZoomFocus) => void;
  /** The region was scrolled (or resized): where it is now. */
  onScroll?: (position: ScrollPosition) => void;
  /**
   * The size of the region the pages sit in (its content box, padding excluded) in CSS px, reported when the canvas mounts
   * and each time it changes: what the layout and the fits fill.
   */
  onViewport?: (viewport: Viewport, anchor?: ViewportAnchor) => void;
  /**
   * While the grid animates its tracks the size is not reported per frame; this gives the scale the content would have at the
   * region's size of that frame (a fit follows it as a transform, around the point under the centre) and the new size is committed
   * once at the end. `1` or `null`: no scale.
   */
  fitScale?: (viewport: Viewport) => number | null;
  /** One page shows at a time (the single and two-page modes): a wheel turn at the end of the shown page goes to the next or the previous. */
  paged?: boolean;
  onPageTurn?: (direction: 1 | -1) => void;
  /** Gets the scroll region when it mounts and `null` when it goes away, for whoever scrolls it (the viewer puts the zoom's anchor where it belongs). */
  onRegion?: (region: HTMLDivElement | null) => void;
  /** A file is dragged over the window (visual only). */
  dropActive?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The canvas slot (DESIGN 2): `--color-canvas`, radius 16, padding 24, opaque, and the host of the pages. It is a `<main>` landmark
 * around one focusable scroll region that holds the content, a box as large as the layout says (the pages are placed in it by
 * their own offsets). Page content never sits under the toolbar: the **scroll-edge scrim**, the top 24 px inside the canvas (8
 * solid, 16 fade, layer 4, no pointer events), appears as soon as the region is scrolled. `scroll-padding-top` is 24 so a page
 * scrolled into view clears the scrim. The canvas isolates its layers (`isolate`), so its local z-indexes (page, text layer,
 * annotations, scrim) never meet the global ones.
 *
 * The browser's own scroll anchoring is off (`overflow-anchor: none`): the viewer decides where the scroll position goes when the layout changes.
 *
 * It knows the DOM and nothing about documents: it reports the region's scroll position and size, the zoom gestures (Ctrl/Cmd+wheel
 * and the pinch of WKWebView) with the point they are centred on, and a wheel turn that asks for another page.
 */
export function Canvas({
  content,
  children,
  pageCount,
  busy,
  onWheelZoom,
  onPinch,
  onScroll,
  onViewport,
  fitScale,
  paged = false,
  onPageTurn,
  onRegion,
  dropActive = false,
  className,
  style,
}: CanvasProps) {
  const t = useT();
  const regionRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const syncRef = useRef<(() => void) | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // The listeners are attached once and read the latest props from here, so a new callback does not detach and attach them.
  const latest = useRef({ onWheelZoom, onPinch, paged, onPageTurn, fitScale });
  useEffect(() => {
    latest.current = { onWheelZoom, onPinch, paged, onPageTurn, fitScale };
  });

  useEffect(() => {
    const region = regionRef.current;
    if (region === null) return;

    /** The viewport position (in the region's content box) of a pointer position given in client coordinates. */
    // While a zoom scales the content its rect is the scaled one: the origin measured before is used until the transform is gone.
    let rest: { x: number; y: number } | null = null;
    const focusAt = (clientX: number, clientY: number): CanvasZoomFocus | undefined => {
      const content = contentRef.current;
      if (content === null) return undefined;
      if (content.style.transform === '' || rest === null) {
        const box = content.getBoundingClientRect();
        // The content's own origin moves with the scroll position; adding it back gives a place that does not.
        rest = { x: box.left + region.scrollLeft, y: box.top + region.scrollTop };
      }
      return { x: clientX - rest.x, y: clientY - rest.y };
    };

    let lastTurn = Number.NEGATIVE_INFINITY;
    const onWheel = (event: WheelEvent) => {
      const props = latest.current;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        props.onWheelZoom(event.deltaY, event.deltaMode, focusAt(event.clientX, event.clientY));
        return;
      }
      if (!props.paged || props.onPageTurn === undefined || event.deltaY === 0) return;
      const down = event.deltaY > 0;
      const atEnd = down ? region.scrollTop + region.clientHeight >= region.scrollHeight - 1 : region.scrollTop <= 0;
      const now = performance.now();
      if (atEnd && now - lastTurn >= PAGE_TURN_COOLDOWN_MS) {
        lastTurn = now;
        props.onPageTurn(down ? 1 : -1);
      }
    };

    let lastScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const { scale, clientX, clientY } = event as GestureEvent;
      const factor = scale / lastScale;
      lastScale = scale;
      const focus = focusAt(clientX, clientY);
      if (focus !== undefined && Number.isFinite(factor) && factor > 0) latest.current.onPinch?.(factor, focus);
    };
    const onGestureEnd = (event: Event) => event.preventDefault();

    region.addEventListener('wheel', onWheel, { passive: false });
    region.addEventListener('gesturestart', onGestureStart, { passive: false });
    region.addEventListener('gesturechange', onGestureChange, { passive: false });
    region.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      region.removeEventListener('wheel', onWheel);
      region.removeEventListener('gesturestart', onGestureStart);
      region.removeEventListener('gesturechange', onGestureChange);
      region.removeEventListener('gestureend', onGestureEnd);
    };
  }, []);

  useEffect(() => {
    const region = regionRef.current;
    if (region === null || onViewport === undefined) return;
    const pad = canvasPadding();
    /** The size last handed on, and the size now (they differ while a track animation holds the report back). */
    let reported: Viewport | null = null;
    let current: Viewport | null = null;
    let freeze: Freeze | null = null;
    let release = 0;

    const begin = () => {
      window.cancelAnimationFrame(release);
      if (freeze !== null || reported === null) return;
      const content = contentRef.current;
      if (content === null) return;
      const box = region.getBoundingClientRect();
      const at = content.getBoundingClientRect();
      freeze = {
        width: reported.width,
        height: reported.height,
        scrollLeft: region.scrollLeft,
        contentWidth: content.offsetWidth,
        originX: box.left + pad + reported.width / 2 - at.left,
        originY: box.top + pad + reported.height / 2 - at.top,
      };
    };

    /** Per frame: a page narrower than the canvas stays centred in it, a wider one keeps its point; a fit is scaled by transform. */
    const follow = (size: Viewport, hold: Freeze) => {
      if (hold.contentWidth <= hold.width + 0.5) {
        region.scrollLeft = Math.max(0, hold.scrollLeft + (hold.width - size.width) / 2);
      }
      const content = contentRef.current;
      if (content === null) return;
      const scale = latest.current.fitScale?.(size) ?? 1;
      content.style.transformOrigin = `${hold.originX}px ${hold.originY}px`;
      content.style.transform = scale === 1 ? '' : `scale(${scale})`;
    };

    const commit = () => {
      if (isLayoutAnimating()) return;
      const hold = freeze;
      freeze = null;
      const size = current;
      if (size === null) return;
      const content = contentRef.current;
      let anchor: ViewportAnchor | undefined;
      if (hold !== null && content !== null) {
        content.style.transform = '';
        content.style.transformOrigin = '';
        const viewX = hold.contentWidth <= hold.width + 0.5 ? size.width / 2 : hold.width / 2;
        const viewY = size.height / 2;
        const box = region.getBoundingClientRect();
        const at = content.getBoundingClientRect();
        anchor = { x: box.left + pad + viewX - at.left, y: box.top + pad + viewY - at.top, viewX, viewY };
      }
      reported = size;
      onViewport(size, anchor);
    };

    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box === undefined) return;
      current = { width: Math.floor(box.width), height: Math.floor(box.height) };
      if (isLayoutAnimating() && reported !== null) {
        begin();
        if (freeze !== null) follow(current, freeze);
        return;
      }
      reported = current;
      onViewport(current);
    });
    observer.observe(region);
    // The size the region really has (its content box, padding and scrollbar excluded) against the one last handed on: a report
    // that was held back or missed would leave the layout wider than the region (a horizontal bar, a page off centre).
    syncRef.current = () => {
      if (isLayoutAnimating() || freeze !== null || reported === null) return;
      const width = Math.floor(region.clientWidth - 2 * pad);
      const height = Math.floor(region.clientHeight - 2 * pad);
      if (width <= 0 || height <= 0 || (width === reported.width && height === reported.height)) return;
      current = { width, height };
      reported = current;
      onViewport(current);
    };
    const stop = subscribeLayoutAnimating(() => {
      if (isLayoutAnimating()) begin();
      // Ended: commit in the next frame, unless another animation has started by then (a reversal).
      else release = window.requestAnimationFrame(commit);
    });
    if (isLayoutAnimating()) begin();
    return () => {
      stop();
      syncRef.current = null;
      window.cancelAnimationFrame(release);
      observer.disconnect();
      const content = contentRef.current;
      if (freeze !== null && content !== null) {
        content.style.transform = '';
        content.style.transformOrigin = '';
      }
    };
  }, [onViewport]);

  // After every layout of the content: is the size the layout was made for still the region's?
  useEffect(() => {
    syncRef.current?.();
  });

  const setRegion = useCallback(
    (element: HTMLDivElement | null) => {
      regionRef.current = element;
      onRegion?.(element);
    },
    [onRegion],
  );

  return (
    <main
      data-action-scope="canvas"
      style={style}
      className={cx('relative isolate min-h-0 min-w-0 overflow-hidden rounded-panel surface-canvas', className)}
    >
      <div
        ref={setRegion}
        role="region"
        aria-label={t('canvas.region')}
        aria-busy={busy}
        tabIndex={0}
        onScroll={(event) => {
          const region = event.currentTarget;
          setScrolled(region.scrollTop > 0);
          onScroll?.({ left: region.scrollLeft, top: region.scrollTop });
        }}
        className="flex size-full scroll-pt-canvas-gutter overflow-auto p-canvas-gutter [overflow-anchor:none] [scrollbar-gutter:stable] [&::-webkit-scrollbar-track]:bg-canvas [&::-webkit-scrollbar-corner]:bg-canvas"
      >
        {pageCount === 0 ? (
          <p className="m-auto text-text-muted">{t('canvas.noPages')}</p>
        ) : content !== null ? (
          <div
            ref={contentRef}
            data-canvas-content=""
            className="relative m-auto flex-none"
            // The tour's card may ask for scroll height after the last page; a margin does not touch the viewport.
            style={{ width: content.width, height: content.height, marginBottom: 'var(--canvas-extra-scroll, 0px)' }}
          >
            {children}
          </div>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        data-scrim={scrolled ? 'visible' : 'hidden'}
        className={cx(
          'canvas-scrim pointer-events-none absolute inset-x-0 top-0 z-canvas-scrim transition-opacity',
          scrolled ? 'opacity-100' : 'opacity-0',
        )}
      />
      <AnimatePresence>
        {dropActive && (
          // The drop overlay over a document (DESIGN 3.11): G2, inset 8 px, above everything in the canvas; the preview card
          // is centred in it (MOTION 4.5) with the label below.
          <motion.div
            key="drop"
            data-drop-overlay=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: SPRING.base }}
            exit={{ opacity: 0, transition: SPRING.fast }}
            className="glass-2 pointer-events-none absolute inset-1 z-drag flex flex-col items-center justify-center gap-3 rounded-panel"
          >
            <DropCard />
            <p className="m-0 font-display text-xl">{t('canvas.dropToOpen')}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
