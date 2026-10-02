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
