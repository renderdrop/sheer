import type { Transition } from 'motion/react';

/**
 * The one spring (MOTION 1, ADR-022) for every JS animation. The numbers mirror `--motion-*` of tokens.css; tokens.test.ts
 * fails on drift. A CSS transition with `--ease-spring` and a Motion spring of the same `visualDuration` look the same.
 */
export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;

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
export const ENTER_SCALE = 0.96;

export const ZOOM_SNAP_BAND = 0.08;
export const ZOOM_INERTIA_S = 0.1;
export const ZOOM_INERTIA_CAP = 1.5;
export const JUMP_ANIMATE_MAX_VIEWPORTS = 2;
