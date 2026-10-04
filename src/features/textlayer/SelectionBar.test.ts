import { describe, expect, it } from 'vitest';

import { relativeTime } from '../comments/time';
import { placeBar } from './SelectionBar';

const canvas = { top: 0, bottom: 600, left: 0, right: 800 };
const bar = { width: 300, height: 40 };

describe('placeBar', () => {
  it('goes 8 above the selection, clamped into the canvas', () => {
    const place = placeBar({ first: { top: 200, left: 700 }, last: { bottom: 220 } }, canvas, bar, 8);
    expect(place).toEqual({ left: 800 - 8 - 300, top: 152, below: false });
  });

  it('flips below when there is no room above', () => {
    const place = placeBar({ first: { top: 20, left: 100 }, last: { bottom: 40 } }, canvas, bar, 8);
    expect(place).toEqual({ left: 100, top: 48, below: true });
  });

  it('is hidden when the selection scrolled out', () => {
    expect(placeBar({ first: { top: 900, left: 0 }, last: { bottom: 920 } }, canvas, bar, 8)).toBeNull();
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2024-01-10T12:00:00Z');
  it('is relative under a week and a date after', () => {
    expect(relativeTime('2024-01-10T11:00:00Z', 'en', now)).toBe('1 hour ago');
    expect(relativeTime('2024-01-08T12:00:00Z', 'en', now)).toBe('2 days ago');
    expect(relativeTime('2023-12-01T12:00:00Z', 'en', now)).toBe('Dec 1, 2023');
    expect(relativeTime('nope', 'en', now)).toBe('');
  });
});
