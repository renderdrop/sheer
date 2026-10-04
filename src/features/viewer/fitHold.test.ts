import { describe, expect, it } from 'vitest';

import { armFitHold, consumeFitHold, dropFitHold } from './fitHold';

describe('fit hold (ADR-056)', () => {
  it('holds for the next size report only, with no timer', () => {
    armFitHold(1000, 700);
    expect(consumeFitHold(1000, 700)).toBe(true);
    expect(consumeFitHold(1000, 700)).toBe(false);
  });

  it('does not hold when the window itself changed size or the hold was dropped', () => {
    armFitHold(1000, 700);
    expect(consumeFitHold(1200, 700)).toBe(false);
    armFitHold(1000, 700);
    dropFitHold();
    expect(consumeFitHold(1000, 700)).toBe(false);
  });
});
