import { describe, expect, it } from 'vitest';

import { armFitHold, consumeFitHold, dropFitHold, inspectorFlipped } from './fitHold';

const off = { inspectorReserved: false, inspectorVisible: false };
const on = { inspectorReserved: true, inspectorVisible: true };

describe('fit hold (ADR-056)', () => {
  it('flags an inspector slot flip only', () => {
    expect(inspectorFlipped(off, on)).toBe(true);
    expect(inspectorFlipped(on, off)).toBe(true);
    expect(inspectorFlipped(on, on)).toBe(false);
    expect(inspectorFlipped(off, off)).toBe(false);
  });

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
