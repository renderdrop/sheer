// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { RECENT_COLOURS_KEY, parseRecent, useRecentColours } from './recentColours';

describe('recent colours store', () => {
  beforeEach(() => {
    localStorage.clear();
    useRecentColours.setState({ colours: [] });
  });
  it('adds newest first, deduplicated, and persists', () => {
    useRecentColours.getState().add([1, 2, 3]);
    useRecentColours.getState().add([4, 5, 6]);
    useRecentColours.getState().add([1, 2, 3]);
    expect(useRecentColours.getState().colours).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(JSON.parse(localStorage.getItem(RECENT_COLOURS_KEY) ?? '[]')).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });
  it('drops bad stored entries', () => {
    expect(parseRecent([[1, 2, 3], [300, 0, 0], 'x', [1, 2], [1, 2, 3]])).toEqual([[1, 2, 3]]);
    expect(parseRecent('nope')).toEqual([]);
  });
});
