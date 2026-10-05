import { describe, expect, it } from 'vitest';

import { letterSpacingFor } from './fit';

describe('letterSpacingFor', () => {
  it('spreads the difference over the characters', () => {
    expect(letterSpacingFor(100, 84, 10, 12)).toBeCloseTo(-1.6);
    expect(letterSpacingFor(100, 110, 5, 12)).toBeCloseTo(2);
  });
  it('leaves a close fit and unmeasurable runs alone', () => {
    expect(letterSpacingFor(100, 100.5, 10, 12)).toBe(0);
    expect(letterSpacingFor(null, 80, 10, 12)).toBe(0);
    expect(letterSpacingFor(0, 80, 10, 12)).toBe(0);
    expect(letterSpacingFor(100, 0, 10, 12)).toBe(0);
    expect(letterSpacingFor(100, 80, 0, 12)).toBe(0);
  });
  it('is bounded', () => {
    expect(letterSpacingFor(10, 1000, 1, 10)).toBe(20);
    expect(letterSpacingFor(1000, 10, 1, 10)).toBe(-20);
  });
});
