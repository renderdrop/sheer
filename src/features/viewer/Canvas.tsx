import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { cx } from '../../components/cx';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { useT } from '../../i18n';
import type { PageImage, Viewport } from './useViewer';

export interface CanvasProps {
  /** The rendered page, or `null` while there is none yet. */
  image: PageImage | null;
  zoom: number;
  /** Zero-based. */
  pageIndex: number;
  pageCount: number;
  /** A render is in flight. */
  busy: boolean;
  /** Ctrl/Cmd+wheel and pinch (browsers report a pinch as ctrl+wheel). Needs a non-passive listener, so it is attached here. */
  onWheelZoom: (deltaY: number, deltaMode: number) => void;
  /**
   * The size of the region the page sits in (its content box, padding excluded) in CSS px, reported when the canvas mounts
   * and each time it changes: what "fit width" and "fit page" fill.
   */
  onViewport?: (viewport: Viewport) => void;
  /** A file is dragged over the window (visual only). */
  dropActive?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The canvas slot (DESIGN 2): `--color-canvas`, radius 16, padding 24, opaque, and the host of the page renderer. It is a
 * `<main>` landmark around one focusable scroll region. Page content never sits under the toolbar: the **scroll-edge scrim**,
 * the top 24 px inside the canvas (8 solid, 16 fade, layer 4, no pointer events), appears as soon as the region is scrolled.
 * `scroll-padding-top` is 24 so a page scrolled into view clears the scrim. The canvas isolates its layers (`isolate`), so
 * its local z-indexes (page, text layer, annotations, scrim) never meet the global ones.
 */
export function Canvas({
  image,
  zoom,
  pageIndex,
  pageCount,
  busy,
  onWheelZoom,
  onViewport,
  dropActive = false,
  className,
  style,
}: CanvasProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const region = scrollRef.current;
    if (region === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onWheelZoom(event.deltaY, event.deltaMode);
    };
    region.addEventListener('wheel', onWheel, { passive: false });
    return () => region.removeEventListener('wheel', onWheel);
  }, [onWheelZoom]);

  useEffect(() => {
    const region = scrollRef.current;
    if (region === null || onViewport === undefined) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box !== undefined) onViewport({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, [onViewport]);

  return (
    <main
      data-action-scope="canvas"
      style={style}
      className={cx('relative isolate min-h-0 min-w-0 overflow-hidden rounded-panel bg-canvas', className)}
    >
      <div
        ref={scrollRef}
        role="region"
        aria-label={t('canvas.region')}
        aria-busy={busy}
        tabIndex={0}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        className="flex size-full scroll-pt-3 overflow-auto p-3"
      >
        {pageCount === 0 ? (
          <p className="m-auto text-text-muted">{t('canvas.noPages')}</p>
        ) : image !== null ? (
          <div className="z-canvas-page m-auto flex-none bg-page shadow-page">
            <img
              className="block h-auto max-w-none"
              src={image.url}
              alt={t('canvas.pageImage', { page: pageIndex + 1, total: pageCount })}
              style={{ width: Math.round(image.widthPt * CSS_PX_PER_PT * zoom) }}
              draggable={false}
            />
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
