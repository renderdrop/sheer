import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOLD_MS } from './engine';
import { SHIPPED_STEPS } from './steps';
import { useTour } from './store';

const tour = () => useTour.getState();

beforeEach(() => {
  vi.useFakeTimers();
  tour().start(1);
});
afterEach(() => {
  tour().end('restart');
  vi.useRealTimers();
});

describe('the tour store', () => {
  it('Next advances without doing the step, Back returns to it, Back is a no-op on step 1', () => {
    tour().back();
    expect(tour().index).toBe(0);
    tour().next();
    expect(tour()).toMatchObject({ index: 1, phase: 'waiting' });
    tour().back();
    expect(tour()).toMatchObject({ index: 0, phase: 'waiting' });
  });

  it('keeps a done step done when going back, and does not advance by itself then', () => {
    tour().complete();
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour().index).toBe(1);
    tour().back();
    expect(tour()).toMatchObject({ index: 0, phase: 'done' });
    vi.advanceTimersByTime(HOLD_MS * 3);
    expect(tour().index).toBe(0);
  });

  it('Next on a done step advances at once; Next on the last step finishes', () => {
    tour().complete();
    tour().next();
    expect(tour().index).toBe(1);
    useTour.setState({ index: SHIPPED_STEPS.length - 1 });
    tour().next();
    expect(tour().phase).toBe('finishing');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour().docId).toBeNull();
  });

  it('pauses and resumes, and a restart clears the pause', () => {
    tour().pause();
    expect(tour().paused).toBe(true);
    tour().resume();
    expect(tour().paused).toBe(false);
    tour().pause();
    tour().start(2);
    expect(tour().paused).toBe(false);
  });
});
