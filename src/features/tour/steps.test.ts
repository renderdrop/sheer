import { describe, expect, it } from 'vitest';

import { SHIPPED_STEPS, parseSteps } from './steps';

describe('parseSteps', () => {
  it('yields no steps for a missing or malformed steps array', () => {
    expect(parseSteps({})).toEqual([]);
    expect(parseSteps(null)).toEqual([]);
    expect(parseSteps({ steps: 'x' })).toEqual([]);
  });

  it('drops steps without a string id or anchor.a', () => {
    const steps = parseSteps({
      steps: [
        { id: 'ok', shipped: true, anchor: { a: 'x' } },
        { shipped: true, anchor: { a: 'x' } },
        { id: 3, anchor: { a: 'x' } },
        { id: 'no-anchor' },
        { id: 'bad-anchor', anchor: { a: 1 } },
        null,
      ],
    });
    expect(steps.map((step) => step.id)).toEqual(['ok']);
  });

  it('ships the real manifest', () => {
    expect(SHIPPED_STEPS.length).toBeGreaterThan(0);
  });
});
