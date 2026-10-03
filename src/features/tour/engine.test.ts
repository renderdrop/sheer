import { describe, expect, it } from 'vitest';

import { NAVIGATE_SETTLE_MS, ZOOM_FACTOR, isSatisfied, settleDelay } from './engine';
import { SHIPPED_STEPS, shippedOf, type TourStep } from './steps';

const view = (pageIndex: number, zoom: number) => ({ pageIndex, zoom });

describe('step conditions', () => {
  it('completes Navigate on page 2 or later, and not on page 1', () => {
    expect(isSatisfied('navigate', view(0, 1), { zoom: 1 })).toBe(false);
    expect(isSatisfied('navigate', view(1, 1), { zoom: 1 })).toBe(true);
    expect(isSatisfied('navigate', view(3, 1), { zoom: 1 })).toBe(true);
  });

  it('completes Zoom at 1.2 times the zoom the step started with', () => {
    expect(isSatisfied('zoom', view(0, 1.19), { zoom: 1 })).toBe(false);
    expect(isSatisfied('zoom', view(0, ZOOM_FACTOR), { zoom: 1 })).toBe(true);
    expect(isSatisfied('zoom', view(0, 1.49), { zoom: 1.25 })).toBe(false);
    expect(isSatisfied('zoom', view(0, 1.5), { zoom: 1.25 / 1.04 })).toBe(true);
  });

  it('never completes Open or an unknown step by state', () => {
    expect(isSatisfied('open', view(5, 4), { zoom: 1 })).toBe(false);
    expect(isSatisfied('nonsense', view(5, 4), { zoom: 1 })).toBe(false);
  });

  it('lets only Navigate settle', () => {
    expect(settleDelay('navigate')).toBe(NAVIGATE_SETTLE_MS);
    expect(settleDelay('zoom')).toBe(0);
  });
});

describe('the step manifest', () => {
  it('has the three M1 steps, in order, and nothing unshipped', () => {
    expect(SHIPPED_STEPS.map((step) => step.id)).toEqual(['open', 'navigate', 'zoom']);
    expect(SHIPPED_STEPS.every((step) => step.shipped)).toBe(true);
  });

  it('drops steps that are not shipped', () => {
    const step = (id: string, shipped: boolean): TourStep => ({
      id,
      page: 'W',
      ships: 'M1',
      shipped,
      detect: 'auto',
      anchor: { a: 'x' },
    });
    expect(shippedOf([step('a', true), step('b', false), step('c', true)]).map((s) => s.id)).toEqual(['a', 'c']);
  });
});
