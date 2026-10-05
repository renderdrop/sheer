import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useView } from '../../stores/view';
import type { ThumbnailLayout } from './layout';
import { prefersReducedMotion, tokenMs } from './motion';

interface Props {
  docId: number;
  layout: ThumbnailLayout;
  /** The height of the scroll region in px: a move farther than this is a far jump. */
  viewportHeight: number;
}

/** How the indicator got to its place: it travelled (translateY), or it faded in at the target, or it did not move. */
type Mode = 'still' | 'travel' | 'fade';

/**
 * MOTION spell 2: the current page's 2 px Solar border is one element that travels between the thumbnails (a `translateY` transition,
 * `--motion-base`). A jump of more than one viewport of thumbnails, and any change under reduced motion, skips the travel: the border
 * fades in at the target. A change of the layout alone (the panel's width, page sizes that arrived) moves it without any animation.
 */
export function PageIndicator({ docId, layout, viewportHeight }: Props) {
  const page = useView((state) => state.byDoc[docId]?.pageIndex ?? 0);
  const index = Math.min(Math.max(page, 0), Math.max(layout.count - 1, 0));
  const top = layout.count > 0 ? layout.top(index) : 0;
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ index: number; top: number; mode: Mode; n: number; live: boolean }>({
    index,
    top,
    mode: 'still',
    n: 0,
    live: false,
  });
  // A change of the current page, noted while rendering (the derived-state pattern): the mode applies in the same commit as the move.
  if (state.index !== index) {
    const far = prefersReducedMotion() || Math.abs(top - state.top) > viewportHeight;
    setState({ index, top, mode: far ? 'fade' : 'travel', n: state.n + 1, live: true });
  } else if (state.top !== top) {
    setState({ ...state, top });
  }

  // Fade: start from nothing at the target, flush that, and let the transition bring the border in.
  useLayoutEffect(() => {
    const element = ref.current;
    if (state.n === 0 || state.mode !== 'fade' || element === null) return;
    element.style.transition = 'none';
    element.style.opacity = '0';
    element.getBoundingClientRect();
    element.style.transition = '';
    element.style.opacity = '';
  }, [state.n, state.mode]);

  // The travel is over after `--motion-base`: later moves of the layout are not animated.
  const { n, live } = state;
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(
      () => setState((now) => (now.n === n ? { ...now, live: false } : now)),
      tokenMs('--motion-base', 160),
    );
    return () => clearTimeout(timer);
  }, [n, live]);

  if (layout.count === 0) return null;
  const size = layout.thumbnailSize(index);
  const mode: Mode = state.live ? state.mode : 'still';
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-thumb-indicator=""
      data-mode={mode}
      className="pointer-events-none absolute inset-x-0 top-0 flex justify-center"
      style={{ transform: `translateY(${top}px)` }}
    >
      <div
        className="box-border rounded-sm border-2 border-accent"
        style={{ width: size.width, height: size.height }}
      />
    </div>
  );
}
