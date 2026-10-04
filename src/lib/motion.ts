import type { Transition } from 'motion/react';

/**
 * The one spring (MOTION 1, ADR-022) for every JS animation. The numbers mirror `--motion-*` of tokens.css; tokens.test.ts
 * fails on drift. A CSS transition with `--ease-out` and a Motion spring of the same `visualDuration` look the same.
 */
export const DURATION = { fast: 0.12, base: 0.16, slow: 0.18 } as const;

/** Bounce of the spring: damping ratio .85, peak overshoot 0.6 %. */
export const SPRING_BOUNCE = 0.15;

/** A spring of the given visual duration in seconds. Prefer `SPRING.fast/base/slow`. */
export function spring(visualDuration: number): Transition {
  return { type: 'spring', bounce: SPRING_BOUNCE, visualDuration };
}

export const SPRING = {
  fast: spring(DURATION.fast),
  base: spring(DURATION.base),
  slow: spring(DURATION.slow),
} as const;

/** Start scale of an entering popover or dialog (`--scale-enter`). */
export const ENTER_SCALE = 0.98;

/** The annotation flash after a jump (MOTION 4.8): two blinks in this many ms. */
export const FLASH_MS = 640;

export const ZOOM_SNAP_BAND = 0.08;
export const ZOOM_INERTIA_S = 0.1;
export const ZOOM_INERTIA_CAP = 1.5;
export const JUMP_ANIMATE_MAX_VIEWPORTS = 2;

/** Velocity samples of a zoom gesture are kept for this many velocity windows. */
export const ZOOM_SAMPLE_WINDOWS = 4;
/** Slack after a fade's duration before its end is acted on (ms). */
export const FADE_END_SLACK_MS = 40;
/** The drop card's lift if the tokens cannot be read (`--offset-enter` px, `--scale-lift`). */
export const DROP_LIFT_FALLBACK = { y: 8, scale: 1.02 } as const;
