import { useEffect, useRef } from 'react';

import { SolarGlow } from '../../components';
import { onDropPoint } from './dropPoint';

/** Opacity of the `drop` glow at the window's edge and at its centre (MOTION spell 4). */
export const DROP_GLOW_MIN = 0.35;
export const DROP_GLOW_MAX = 1;
/** Reduced motion, and before the first cursor position is known: a fixed glow. */
export const DROP_GLOW_FIXED = 0.6;

/** Glow opacity for a cursor at (x, y) in a window of width x height: 1 at the centre, 0.35 on the edge (and beyond), linear in between. */
export function proximityOpacity(x: number, y: number, width: number, height: number): number {
  if (width <= 0 || height <= 0) return DROP_GLOW_FIXED;
  // Normalised distance from the centre: 0 at the centre, 1 at the middle of an edge (clamped at the corners).
  const dx = (x - width / 2) / (width / 2);
  const dy = (y - height / 2) / (height / 2);
  const distance = Math.min(1, Math.hypot(dx, dy));
  return DROP_GLOW_MAX - (DROP_GLOW_MAX - DROP_GLOW_MIN) * distance;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Drives `element.style.opacity` of the drop glow while `active`: once per animation frame from the last known cursor position
 * (`dragover` / `pointermove` on the window). Opacity only, so nothing lays out. Reduced motion: a fixed 0.6, no listeners.
 * With Tauri's native drag-drop the DOM gets no `dragover`; the position comes from the backend's `dropHover {x, y}` (`dropPoint.ts`), the DOM events stay as a fallback. Until one arrives the glow stays at 0.6.
 */
export function startDropGlow(element: HTMLElement, win: Window = window): () => void {
  element.style.opacity = String(DROP_GLOW_FIXED);
  if (reducedMotion()) return () => undefined;
  let point: { x: number; y: number } | null = null;
  let frame = 0;
  const onMove = (event: { clientX: number; clientY: number }) => {
    point = { x: event.clientX, y: event.clientY };
  };
  const tick = () => {
    if (point !== null) {
      element.style.opacity = proximityOpacity(point.x, point.y, win.innerWidth, win.innerHeight).toFixed(3);
    }
    frame = win.requestAnimationFrame(tick);
  };
  const unsubscribe = onDropPoint((x, y) => onMove({ clientX: x, clientY: y }));
  win.addEventListener('dragover', onMove);
  win.addEventListener('pointermove', onMove);
  frame = win.requestAnimationFrame(tick);
  return () => {
    unsubscribe();
    win.removeEventListener('dragover', onMove);
    win.removeEventListener('pointermove', onMove);
    win.cancelAnimationFrame(frame);
  };
}

/** The `drop` glow layer behind the drop card: clipped to its slot, opacity following the cursor. Mount it only while the drop target shows. */
export function DropGlow() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => (ref.current === null ? undefined : startDropGlow(ref.current)), []);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-drop-glow=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ opacity: DROP_GLOW_FIXED, willChange: 'opacity' }}
    >
      <SolarGlow variant="drop" />
    </div>
  );
}
