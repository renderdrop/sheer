import { useEffect, useRef } from 'react';

import { cx } from './cx';

export interface SkeletonProps {
  /** Shape of the thing it stands for. Default `block`. */
  shape?: 'block' | 'line' | 'circle';
  /** Size classes (`h-4 w-24`, `size-swatch`): layout, not looks. */
  className?: string;
}

const SHAPES = { block: 'rounded-md', line: 'h-4 rounded-sm', circle: 'rounded-pill' } as const;

/** Whether the shimmer loop runs: only while the block is on screen and the window is visible (MOTION 3: loops stop off-screen). */
export function shimmerRuns(onScreen: boolean, documentVisible: boolean): boolean {
  return onScreen && documentVisible;
}

/**
 * Keeps the `data-paused` attribute of `element` in step with `shimmerRuns`; the CSS pauses the sweep while it is set. An attribute,
 * not state: pausing must not render anything. Returns the function that stops watching.
 */
export function watchShimmer(element: HTMLElement): () => void {
  let onScreen = true;
  const apply = () => {
    element.toggleAttribute('data-paused', !shimmerRuns(onScreen, !document.hidden));
  };
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          const last = entries.at(-1);
          if (last !== undefined) onScreen = last.isIntersecting;
          apply();
        })
      : null;
  observer?.observe(element);
  document.addEventListener('visibilitychange', apply);
  apply();
  return () => {
    observer?.disconnect();
    document.removeEventListener('visibilitychange', apply);
  };
}

/**
 * A placeholder (DESIGN 4, MOTION spell 15): a Sand block in the shape of its target with a lighter diagonal band sweeping across
 * (`--shimmer`, linear loop on its own compositor layer, see tokens.css). Static for reduced motion. Hidden from assistive tech.
 */
export function Skeleton({ shape = 'block', className }: SkeletonProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => (ref.current === null ? undefined : watchShimmer(ref.current)), []);
  return <div ref={ref} aria-hidden="true" data-skeleton="" className={cx('bg-subtle', SHAPES[shape], className)} />;
}
