import { describe, expect, it } from 'vitest';

import { everyN, formatSize, isPartition, pageIndices, parseCount, parseRanges, previewRanges } from './ranges';

describe('parseRanges', () => {
  it('reads singles, ranges and open ends', () => {
    expect(parseRanges('1-3, 5, 8-', 10)).toEqual([
      [1, 3],
      [5, 5],
      [8, 10],
    ]);
  });
  it('refuses empty, backwards, beyond the end, zero and junk', () => {
    for (const text of ['', ',', '1,,2', '3-1', '11', '0', '1-11', 'a', '1-2-3', '-3', '1;2']) {
      expect(parseRanges(text, 10), text).toBeNull();
    }
  });
});

describe('ranges helpers', () => {
  it('knows a partition', () => {
    expect(
      isPartition(
        [
          [1, 3],
          [4, 10],
        ],
        10,
      ),
    ).toBe(true);
    expect(
      isPartition(
        [
          [1, 3],
          [5, 10],
        ],
        10,
      ),
    ).toBe(false);
    expect(isPartition([[1, 3]], 10)).toBe(false);
  });
  it('splits every n pages', () => {
    expect(everyN(4, 10)).toEqual([
      [1, 4],
      [5, 8],
      [9, 10],
    ]);
  });
  it('parses counts within bounds', () => {
    expect(parseCount('3', 9)).toBe(3);
    expect(parseCount('0', 9)).toBeNull();
    expect(parseCount('10', 9)).toBeNull();
    expect(parseCount('x', 9)).toBeNull();
  });
  it('previews three ranges then an ellipsis', () => {
    expect(
      previewRanges([
        [1, 2],
        [3, 3],
        [4, 5],
        [6, 7],
      ]),
    ).toBe('1-2, 3, 4-5, …');
  });
  it('lists indices once', () => {
    expect(
      pageIndices([
        [2, 3],
        [3, 4],
      ]),
    ).toEqual([1, 2, 3]);
  });
  it('formats sizes', () => {
    expect(formatSize(1_500_000, 'en')).toBe('1.5 MB');
    expect(formatSize(12, 'en')).toBe('12 B');
  });
});
