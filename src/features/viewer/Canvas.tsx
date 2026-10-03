import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import type { ScrollPosition, Viewport } from './layout';

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
  onViewport?: (viewport: Viewport) => void;
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
  const [scrolled, setScrolled] = useState(false);
  // The listeners are attached once and read the latest props from here, so a new callback does not detach and attach them.
  const latest = useRef({ onWheelZoom, onPinch, paged, onPageTurn });
  useEffect(() => {
    latest.current = { onWheelZoom, onPinch, paged, onPageTurn };
  });

  useEffect(() => {
    const region = regionRef.current;
    if (region === null) return;

    /** The viewport position (in the region's content box) of a pointer position given in client coordinates. */
    const focusAt = (clientX: number, clientY: number): CanvasZoomFocus | undefined => {
      const box = contentRef.current?.getBoundingClientRect();
      if (box === undefined) return undefined;
      // The content's own origin moves with the scroll position, so the pointer's place in the content box is what is left
      // after taking the scroll position off the pointer's place in the content.
      return { x: clientX - box.left - region.scrollLeft, y: clientY - box.top - region.scrollTop };
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
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box !== undefined) onViewport({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, [onViewport]);

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
        className="flex size-full scroll-pt-3 overflow-auto p-3 [overflow-anchor:none]"
      >
        {pageCount === 0 ? (
          <p className="m-auto text-text-muted">{t('canvas.noPages')}</p>
        ) : content !== null ? (
          <div
            ref={contentRef}
            className="relative m-auto flex-none"
            style={{ width: content.width, height: content.height }}
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
      {dropActive && (
        // The drop overlay over a document (DESIGN 3.11): G2, inset 8 px, above everything in the canvas.
        <div
          data-drop-overlay=""
          className="glass-2 pointer-events-none absolute inset-1 z-drag grid place-items-center rounded-panel"
        >
          <p className="m-0 font-display text-xl">{t('canvas.dropToOpen')}</p>
        </div>
      )}
    </main>
  );
}
