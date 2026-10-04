import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { tokenPx } from '../../components/tokens';
import { useUi } from '../../stores/ui';
import { columnLeft, marginMetrics } from '../margin/layout';
import type { PageLayout } from '../viewer/layout';
import { isLayoutAnimating, subscribeLayoutAnimating } from '../viewer/scrollBridge';
import { animationsOff } from '../viewer/zoomMotion';
import { maskImage, maskRects, placeShapes, shapeFrame, type Rect } from './geometry';
import { useDriftPrefs } from './store';

/** The window is visible and has focus: the only time the drift runs (MOTION 19). */
function useWindowActive(): boolean {
  const [active, setActive] = useState(
    () => typeof document === 'undefined' || (!document.hidden && document.hasFocus()),
  );
  useEffect(() => {
    const update = () => setActive(!document.hidden && document.hasFocus());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);
  return active;
}

/** A zoom or a panel slide is running (the layout animates): the drift waits for it. */
function useLayoutBusy(): boolean {
  const [busy, setBusy] = useState(isLayoutAnimating());
  useEffect(() => subscribeLayoutAnimating(() => setBusy(isLayoutAnimating())), []);
  return busy;
}

/** The pages that meet `frame` (with the clearance), as rects. */
function pagesNear(layout: PageLayout, frame: Rect, clearance: number): Rect[] {
  const range = layout.pagesIn(frame.top - clearance, frame.top + frame.height + clearance);
  if (range === null) return [];
  const rects: Rect[] = [];
  for (let page = range.first; page <= range.last; page += 1) {
    const box = layout.box(page);
    if (box !== null) rects.push(box);
  }
  return rects;
}

export interface CanvasDriftProps {
  layout: PageLayout;
  /** The comment margin is shown: its column is cut out as one rect, so no bubble can have a shape under it. */
  margin: boolean;
}

/**
 * Canvas drift (DESIGN 3.5 B12, MOTION 19, a trial): up to three very faint Solar shapes in the gaps around the pages. One layer in
 * the scroll content behind the pages; each shape sits in a static wrapper whose mask cuts out every page and the margin column
 * inflated by `--gap-shape-clearance`, and only the shape inside moves, by a compositor-only CSS animation. The masks are rebuilt
 * when the layout changes, never on scroll; there is no per-frame React work. Not in Seiten, not when the switch is off.
 */
export function CanvasDrift({ layout, margin }: CanvasDriftProps) {
  const enabled = useDriftPrefs((state) => state.enabled);
  const pagesMode = useUi((state) => state.mode === 'pages');
  const reduce = useReducedMotion() === true || animationsOff();
  const active = useWindowActive();
  const busy = useLayoutBusy();

  const shapes = useMemo(() => {
    if (!enabled || pagesMode || layout.isEmpty) return [];
    const clearance = tokenPx('--gap-shape-clearance', 40);
    const travel = tokenPx('--gap-shape-travel', 24);
    const min = tokenPx('--gap-shape-min', 200);
    const max = tokenPx('--gap-shape-max', 360);
    const pagesWidth = layout.pagesWidth;
    const content = { width: layout.width, height: layout.height };
    const placed = placeShapes(
      content,
      { left: (layout.width - pagesWidth) / 2, right: (layout.width + pagesWidth) / 2 },
      [max, min, (min + max) / 2],
    );
    const column: Rect | null = margin
      ? {
          left: columnLeft(layout.width, pagesWidth, marginMetrics().gap),
          top: 0,
          width: 1_000_000,
          height: layout.height,
        }
      : null;
    return placed.map((shape) => {
      const frame = shapeFrame(shape, travel);
      const pages = pagesNear(layout, frame, clearance);
      const obstacles = column === null ? pages : [...pages, column];
      return { shape, frame, mask: maskImage(frame, maskRects(frame, obstacles, clearance)) };
    });
  }, [enabled, pagesMode, layout, margin]);

  if (shapes.length === 0) return null;
  return (
    <div
      aria-hidden="true"
      data-canvas-drift=""
      data-drift={reduce ? 'static' : 'live'}
      data-paused={!active || busy ? 'true' : 'false'}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {shapes.map(({ shape, frame, mask }, index) => (
        <div
          key={index}
          data-drift-frame=""
          className="absolute"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            maskImage: mask,
            WebkitMaskImage: mask,
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
          }}
        >
          <div
            data-drift-shape=""
            className="absolute rounded-full"
            style={
              {
                left: (frame.width - shape.size) / 2,
                top: (frame.height - shape.size) / 2,
                width: shape.size,
                height: shape.size,
                '--dx': shape.dx,
                '--dy': shape.dy,
                '--delay': `calc(var(--gap-drift) * ${-shape.phase})`,
              } as CSSProperties
            }
          />
        </div>
      ))}
    </div>
  );
}
