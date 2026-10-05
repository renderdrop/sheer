import { useReducedMotion } from 'motion/react';

import { usePanelFade, type EnterExit } from '../../components/motion';
import { DURATION, SPRING, spring } from '../../lib/motion';

/** The opacity of a sliding panel is done over this share of the slide (MOTION 4.2). */
const FADE_SHARE = 0.6;

/**
 * A side panel that slides with its grid track (MOTION 4.2): it keeps its final width and moves in from its own edge by its width, inside a clipped track; opacity 0 to 1 over the first 60 % of the slide. It enters in `slow` and slides back
 * out in `base`. `side` is the edge it comes from. Reduced motion: opacity only, as `usePanelFade`.
 */
export function usePanelSlide(side: 'start' | 'end', width: number): EnterExit {
  const reduce = useReducedMotion() === true;
  const fade = usePanelFade();
  // The track changes in one step under reduced motion: a panel that still fades out would leave an empty column for those frames, so it goes at once.
  if (reduce) return { ...fade, exit: { opacity: 0, transition: spring(0) } };
  const from = (side === 'start' ? -1 : 1) * width;
  return {
    initial: { x: from, opacity: 0 },
    animate: {
      x: 0,
      opacity: 1,
      transition: { x: SPRING.slow, opacity: spring(DURATION.slow * FADE_SHARE) },
    },
    exit: { x: from, opacity: 0, transition: SPRING.base },
  };
}
