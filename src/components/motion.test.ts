import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DURATION,
  ENTER_SCALE,
  JUMP_ANIMATE_MAX_VIEWPORTS,
  SPRING,
  SPRING_BOUNCE,
  ZOOM_INERTIA_CAP,
  ZOOM_INERTIA_S,
  ZOOM_SNAP_BAND,
} from '../lib/motion';

/** The Motion presets mirror tokens that CSS reads directly; this keeps the two from drifting apart (MOTION 6). */
const css = readFileSync(fileURLToPath(new URL('../styles/tokens.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = new RegExp(`${name}: *([^;]+);`).exec(css);
  if (match?.[1] === undefined) throw new Error(`token ${name} not found`);
  return match[1].trim();
}

describe('motion presets match tokens.css', () => {
  it('durations', () => {
    expect(token('--motion-fast')).toBe(`${Math.round(DURATION.fast * 1000)}ms`);
    expect(token('--motion-base')).toBe(`${Math.round(DURATION.base * 1000)}ms`);
    expect(token('--motion-slow')).toBe(`${Math.round(DURATION.slow * 1000)}ms`);
  });

  it('entrance scale', () => {
    expect(Number.parseFloat(token('--scale-enter'))).toBe(ENTER_SCALE);
  });

  it('the one spring: bounce .15 at the three visual durations', () => {
    expect(SPRING_BOUNCE).toBe(0.15);
    for (const [name, seconds] of Object.entries(DURATION)) {
      expect(SPRING[name as keyof typeof SPRING], name).toEqual({
        type: 'spring',
        bounce: 0.15,
        visualDuration: seconds,
      });
    }
  });

  it('zoom and scroll constants of MOTION 6', () => {
    expect([ZOOM_SNAP_BAND, ZOOM_INERTIA_S, ZOOM_INERTIA_CAP, JUMP_ANIMATE_MAX_VIEWPORTS]).toEqual([0.08, 0.1, 1.5, 2]);
  });
});
