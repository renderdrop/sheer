import { useReducedMotion, type TargetAndTransition, type Transition } from 'motion/react';

/**
 * Motion presets (DESIGN 1.6). Motion needs numbers, so these mirror `--motion-*`, `--ease-*` and `--scale-enter` of
 * tokens.css; motion.test.ts fails when the two drift apart. CSS transitions use the tokens directly.
 */
export const DURATION = { fast: 0.15, base: 0.2, slow: 0.25, tooltipOut: 0.1 } as const;
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;
/** `--ease-spring` as a Motion spring: transforms only. */
export const SPRING: Transition = { type: 'spring', visualDuration: DURATION.base, bounce: 0.15 };
/** Start scale of an entering popover (`--scale-enter`). */
export const ENTER_SCALE = 0.96;

export interface EnterExit {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
}

function fade(inSeconds: number, outSeconds: number, outEase: typeof EASE_IN | typeof EASE_OUT): EnterExit {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: inSeconds, ease: EASE_OUT } },
    exit: { opacity: 0, transition: { duration: outSeconds, ease: outEase } },
  };
}

/** Opacity fade. Reduced motion changes only the timing: 150 ms ease-out in both directions (DESIGN 1.6). */
export function useFade(inSeconds: number, outSeconds: number): EnterExit {
  const reduce = useReducedMotion() === true;
  return reduce ? fade(DURATION.fast, DURATION.fast, EASE_OUT) : fade(inSeconds, outSeconds, EASE_IN);
}

/** Popover entrance: opacity plus scale .96 to 1 on the spring; exit is opacity only. Reduced motion: opacity only. */
export function usePopoverMotion(): EnterExit {
  const reduce = useReducedMotion() === true;
  if (reduce) return fade(DURATION.fast, DURATION.fast, EASE_OUT);
  return {
    initial: { opacity: 0, scale: ENTER_SCALE },
    animate: {
      opacity: 1,
      scale: 1,
      transition: { opacity: { duration: DURATION.base, ease: EASE_OUT }, scale: SPRING },
    },
    exit: { opacity: 0, transition: { duration: DURATION.fast, ease: EASE_IN } },
  };
}

/**
 * A row that opens and closes in the flow of the page and pushes what is below it (the error banner, DESIGN 3.12): height and
 * opacity over 250 ms, ease-out, in and out. Reduced motion changes it to opacity only, 150 ms ease-out: the row is then
 * there or gone at once and only fades. The row has to clip its content while its height moves (and so should be `overflow:
 * hidden` then and `visible` at rest, so the shadow and the focus ring of what is inside are not cut); Motion cannot switch
 * that for us (`transitionEnd` does not reach `overflow`), so the component does, from the animation's start and end events.
 */
export function useRevealMotion(): EnterExit {
  const reduce = useReducedMotion() === true;
  if (reduce) return fade(DURATION.fast, DURATION.fast, EASE_OUT);
  const transition = { duration: DURATION.slow, ease: EASE_OUT };
  return {
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto', opacity: 1, transition },
    exit: { height: 0, opacity: 0, transition },
  };
}

/**
 * A panel that comes and goes with its grid track (the left panel, DESIGN 3.8): opacity over 250 ms ease-out both ways, in
 * step with the track, which the browser animates (`grid-template-columns`, set up by `MainGrid`). Reduced motion: 150 ms,
 * and the track changes in one step beside it (tokens.css), so only the opacity moves.
 */
export function usePanelFade(): EnterExit {
  const reduce = useReducedMotion() === true;
  const seconds = reduce ? DURATION.fast : DURATION.slow;
  return fade(seconds, seconds, EASE_OUT);
}
