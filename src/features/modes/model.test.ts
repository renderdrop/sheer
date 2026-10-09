import { describe, expect, it } from 'vitest';

import { FIT_START, fitOnResize, tighter } from './model';

describe('the three-step fit (F22.3)', () => {
  it('gives up the 36 squares first, then wraps whole groups, then has nothing left', () => {
    expect(tighter(FIT_START)).toEqual({ step: 2 });
    expect(tighter({ step: 2 })).toEqual({ step: 3 });
    expect(tighter({ step: 3 })).toBeNull();
  });
});

describe('fitOnResize (DESIGN Q6 hysteresis)', () => {
  const two = { step: 2 } as const;
  const three = { step: 3 } as const;

  it('keeps step 1 and a shrinking row as they are', () => {
    expect(fitOnResize(FIT_START, null, 500, 600)).toBe(FIT_START);
    expect(fitOnResize(two, 700, 600, 650)).toBe(two);
  });

  it('returns to step 1 only when 8 px wider than the full row needs', () => {
    expect(fitOnResize(two, 700, 707, 690)).toBe(two);
    expect(fitOnResize(two, 700, 708, 690)).toEqual(FIT_START);
  });

  it('a growing row at step 3 gives the wrap back through step 2', () => {
    expect(fitOnResize(three, 700, 500, 450)).toEqual(two);
    expect(fitOnResize(three, 700, 450, 450)).toBe(three);
  });
});
