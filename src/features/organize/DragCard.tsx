import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { SPRING } from '../../components/motion';
import { tokenPx } from '../../components/tokens';
import { bucketFor } from '../../engine/buckets';
import { renderScheduler, type RenderScheduler } from '../../engine/renderScheduler';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { fitInBox } from './OrganizeCell';
import { readSlots } from './source';

/** The most pages drawn in the stack. */
const STACK = 3;

export interface DragCardProps {
  docId: number;
  /** The dragged pages in document order. */
  ids: readonly number[];
  /** The pointer, in window px. A ref: the card follows it from an animation frame, so a move is no render. */
  pointer: RefObject<{ x: number; y: number }>;
  thumb: number;
  pixelRatio: number;
  scheduler?: RenderScheduler;
}

/** The lift scale from the token, read once per card. */
function readLift(): number {
  return Number.parseFloat(
    typeof document === 'undefined' ? '1' : getComputedStyle(document.documentElement).getPropertyValue('--scale-lift'),
  );
}

/**
 * The card a drag carries (DESIGN 3.28, MOTION 4.5): up to three stacked thumbnails of the dragged pages with a count badge,
 * lifted (scale `--scale-lift`, `--shadow-3`) and following the pointer at `--z-drag`. It only shows pictures that are in the render
 * cache already (the cells in view have asked for them). Reduced motion: `--scale-lift` is 1, so no lift.
 */
export function DragCard({ docId, ids, pointer, thumb, pixelRatio, scheduler = renderScheduler }: DragCardProps) {
  const reduce = useReducedMotion() === true;
  const slots = readSlots(docId);
  const shown = ids.slice(0, STACK).flatMap((id) => slots.find((slot) => slot.id === id) ?? []);
  const [lift] = useState(readLift);
  const offset = tokenPx('--space-1', 4);
  const first = shown[0];
  const box = first === undefined ? { width: thumb, height: thumb } : fitInBox(first, thumb);
  const element = useRef<HTMLDivElement | null>(null);
  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  useEffect(() => {
    let frame = 0;
    let last = '';
    const tick = () => {
      const { x, y } = pointer.current ?? { x: 0, y: 0 };
      const next = `translate(${x - halfWidth}px, ${y - halfHeight}px)`;
      if (next !== last && element.current !== null) {
        last = next;
        element.current.style.transform = next;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [pointer, halfWidth, halfHeight]);
  const start = pointer.current ?? { x: 0, y: 0 };
  return (
    <div
      ref={element}
      aria-hidden="true"
      data-drag-card=""
      className="pointer-events-none fixed start-0 top-0 z-drag"
      style={{
        transform: `translate(${start.x - halfWidth}px, ${start.y - halfHeight}px)`,
        width: box.width,
        height: box.height,
      }}
    >
      <motion.div
        className="relative size-full"
        initial={{ scale: 1 }}
        animate={{ scale: reduce || !Number.isFinite(lift) ? 1 : lift }}
        transition={SPRING.base}
      >
        {[...shown].reverse().map((slot, reversed) => {
          const depth = shown.length - 1 - reversed;
          const size = fitInBox(slot, thumb);
          const turned = slot.rotation === 90 || slot.rotation === 270;
          const bucket = bucketFor(size.width / ((turned ? slot.height : slot.width) * CSS_PX_PER_PT), pixelRatio);
          const entry = scheduler.cache.best(docId, slot.id, 0, bucket, undefined, slot.rev);
          return (
            <div
              key={slot.id}
              className="absolute overflow-hidden rounded-sm bg-page shadow-3"
              style={{ width: size.width, height: size.height, left: depth * offset, top: depth * offset }}
            >
              {entry !== undefined && (
                <img src={scheduler.cache.urlOf(entry)} alt="" draggable={false} className="size-full max-w-none" />
              )}
            </div>
          );
        })}
        {ids.length > 1 && (
          <span className="absolute -end-2 -top-2 inline-flex h-(--pill-height) min-w-6 items-center justify-center rounded-pill bg-accent px-2 text-xs tabular-nums text-on-accent">
            {ids.length}
          </span>
        )}
      </motion.div>
    </div>
  );
}
