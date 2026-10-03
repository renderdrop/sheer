import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { DURATION, SPRING, spring } from '../../lib/motion';
import { DropCardFace } from './DropCard';
import type { OpenSource, SourceRect } from './openTransition';

/** A clone that has no page to fly to by now is dropped: the page never mounted (a failed render, a closed document). */
export const CLONE_WAIT_MS = 2000;

/** The last share of the flight over which the clone fades out while the page's render fades in under it (MOTION 4.6). */
const FADE_SHARE = 0.6;

export interface OpenCloneProps {
  source: OpenSource;
  /** Where the page is now, `null` until it is laid out. The clone waits where it is. */
  target: SourceRect | null;
  onDone: () => void;
}

/**
 * The shared-element clone of MOTION 4.6: a copy of the source at `--z-drag`, travelling with `translate` and `scale` (no size
 * properties) to the page's rect, fading out over the last 60 % (the scaled corners would show a stretched radius for longer otherwise) while the page fades in under it, then removed. Reduced motion
 * has no clone.
 */
export function OpenClone({ source, target, onDone }: OpenCloneProps) {
  const reduce = useReducedMotion() === true;
  const ref = useRef<HTMLDivElement | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    if (reduce) {
      done.current();
      return;
    }
    // The wait is for the page: it starts when the page's rect arrives (and restarts if it moves), not at mount.
    const timer = window.setTimeout(() => done.current(), CLONE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [reduce, target]);

  useEffect(() => {
    const element = ref.current;
    if (element === null || target === null || reduce) return;
    const { rect } = source;
    element.style.willChange = 'transform, opacity';
    const moved = animate(
      element,
      {
        x: target.left - rect.left,
        y: target.top - rect.top,
        scaleX: target.width / rect.width,
        scaleY: target.height / rect.height,
      },
      SPRING.slow,
    );
    const faded = animate(
      element,
      { opacity: 0 },
      { ...spring(DURATION.slow * FADE_SHARE), delay: DURATION.slow * (1 - FADE_SHARE) },
    );
    faded.then(
      () => done.current(),
      () => undefined,
    );
    return () => {
      moved.stop();
      faded.stop();
    };
  }, [source, target, reduce]);

  if (reduce) return null;
  const { rect } = source;
  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      data-open-clone=""
      className={`pointer-events-none fixed z-drag origin-top-left overflow-hidden rounded-sm ${source.kind === 'tile' ? 'bg-tile' : 'bg-surface-solid'}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {source.kind === 'image' && source.src !== undefined ? (
        <img src={source.src} alt="" draggable={false} className="size-full object-cover" />
      ) : source.kind === 'tile' ? null : (
        <DropCardFace />
      )}
    </div>,
    document.body,
  );
}
