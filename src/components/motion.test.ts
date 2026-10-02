import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DURATION, EASE_IN, EASE_OUT, ENTER_SCALE, SPRING } from './motion';

/** The Motion presets mirror tokens that CSS reads directly; this keeps the two from drifting apart. */
const css = readFileSync(fileURLToPath(new URL('../styles/tokens.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (match?.[1] === undefined) throw new Error(`token ${name} not found`);
  return match[1].trim();
}

const bezier = (value: string): number[] => {
  const numbers = /cubic-bezier\(([^)]+)\)/.exec(value)?.[1];
  if (numbers === undefined) throw new Error(`not a cubic-bezier: ${value}`);
  return numbers.split(',').map((part) => Number.parseFloat(part));
};

describe('motion presets match tokens.css', () => {
  it('durations', () => {
    expect(token('--motion-fast')).toBe(`${DURATION.fast * 1000}ms`);
    expect(token('--motion-base')).toBe(`${DURATION.base * 1000}ms`);
    expect(token('--motion-slow')).toBe(`${DURATION.slow * 1000}ms`);
  });

  it('easings', () => {
    expect(bezier(token('--ease-out'))).toEqual([...EASE_OUT]);
    expect(bezier(token('--ease-in'))).toEqual([...EASE_IN]);
  });

  it('entrance scale', () => {
    expect(Number.parseFloat(token('--scale-enter'))).toBe(ENTER_SCALE);
  });

  it('spring is DESIGN 1.6: visual duration 0.2, bounce 0.15', () => {
    expect(SPRING).toMatchObject({ type: 'spring', visualDuration: 0.2, bounce: 0.15 });
  });
});
