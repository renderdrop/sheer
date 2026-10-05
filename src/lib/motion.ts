import type { Transition } from 'motion/react';

/**
 * The JS durations (MOTION v2 §1). The numbers mirror `--motion-*` of tokens.css; tokens.test.ts fails on drift.
 */
export const DURATION = { fast: 0.12, base: 0.16, slow: 0.18 } as const;

/** `--ease-out` (cubic-bezier(0.2, 0, 0, 1)) for JS tweens; tokens.test.ts watches the token. */
export const EASE_OUT = [0.2, 0, 0, 1] as const;

/** An ease-out tween of the given duration in seconds (MOTION v2 rule 1: one curve, no spring, no overshoot). */
export function tween(duration: number): Transition {
  return { type: 'tween', ease: EASE_OUT, duration };
}

export const TWEEN = {
  fast: tween(DURATION.fast),
  base: tween(DURATION.base),
  slow: tween(DURATION.slow),
} as const;

/** @deprecated v1.1 name (ADR-022) kept so files of other packages compile; use `tween`. */
export const spring = tween;
/** @deprecated use `TWEEN`. */
export const SPRING = TWEEN;

/** Start scale of an entering popover or dialog (`--scale-enter`). */
export const ENTER_SCALE = 0.98;

/** Spell 17: a zoom within +-3 % of 100 %, fit width or fit page snaps to it at the end of the gesture. */
export const ZOOM_SNAP_BAND = 0.03;
export const ZOOM_INERTIA_S = 0.1;
export const ZOOM_INERTIA_CAP = 1.5;
export const JUMP_ANIMATE_MAX_VIEWPORTS = 2;

/** Velocity samples of a zoom gesture are kept for this many velocity windows. */
export const ZOOM_SAMPLE_WINDOWS = 4;
/** Slack after a fade's duration before its end is acted on (ms). */
export const FADE_END_SLACK_MS = 40;
/** The drop card's lift if the tokens cannot be read (`--offset-enter` px, `--scale-lift`). */
export const DROP_LIFT_FALLBACK = { y: 8, scale: 1.02 } as const;
