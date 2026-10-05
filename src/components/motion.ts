import { useReducedMotion, type TargetAndTransition } from 'motion/react';

import { DURATION, ENTER_SCALE, SPRING, TWEEN, tween } from '../lib/motion';

/**
 * Motion presets (MOTION 1 to 3). Every animation is the one tween from `src/lib/motion.ts`; an exit is one step shorter than
 * its enter and opacity only. Reduced motion: opacity only, enter base, exit fast.
 */
export { DURATION, ENTER_SCALE, SPRING, TWEEN };

export interface EnterExit {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
}

function fade(inSeconds: number, outSeconds: number): EnterExit {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: tween(inSeconds) },
    exit: { opacity: 0, transition: tween(outSeconds) },
  };
}

/** Opacity fade. Reduced motion: enter base, exit fast, whatever timings it is asked for (MOTION 5). */
export function useFade(inSeconds: number, outSeconds: number): EnterExit {
  const reduce = useReducedMotion() === true;
  return reduce ? fade(DURATION.base, DURATION.fast) : fade(inSeconds, outSeconds);
}

/** Popover, menu and dialog entrance: opacity plus scale .96 to 1 (base); exit is opacity only (fast). Reduced motion: opacity only. */
export function usePopoverMotion(): EnterExit {
  const reduce = useReducedMotion() === true;
  if (reduce) return fade(DURATION.base, DURATION.fast);
  return {
    initial: { opacity: 0, scale: ENTER_SCALE },
    animate: { opacity: 1, scale: 1, transition: TWEEN.base },
    exit: { opacity: 0, transition: TWEEN.fast },
  };
}

/**
 * Banner reveal ONLY (MOTION allows a per-frame `height` animation for nothing else; use transform/opacity elsewhere).
 * A row that opens and closes in the flow of the page and pushes what is below it (the error banner, DESIGN 3.12): height and
 * opacity, slow in and base out. Reduced motion changes it to opacity only: the row is then there or gone at once and only
 * fades. The row has to clip its content while its height moves (and so should be `overflow: hidden` then and `visible` at
 * rest, so the shadow and the focus ring of what is inside are not cut); Motion cannot switch that for us (`transitionEnd`
 * does not reach `overflow`), so the component does, from the animation's start and end events.
 */
export function useRevealMotion(): EnterExit {
  const reduce = useReducedMotion() === true;
  if (reduce) return fade(DURATION.base, DURATION.fast);
  return {
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto', opacity: 1, transition: TWEEN.slow },
    exit: { height: 0, opacity: 0, transition: TWEEN.base },
  };
}

/**
 * A panel that comes and goes with its grid track (the left panel, DESIGN 3.8): opacity, slow in and base out, in step with
 * the track, which the browser animates (`grid-template-columns`, set up by `MainGrid`). Reduced motion: enter base, exit
 * fast, and the track changes in one step beside it (tokens.css), so only the opacity moves.
 */
export function usePanelFade(): EnterExit {
  const reduce = useReducedMotion() === true;
  return reduce ? fade(DURATION.base, DURATION.fast) : fade(DURATION.slow, DURATION.base);
}
