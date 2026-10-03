import { describe, expect, it } from 'vitest';

import { buildRows, rowRange } from './rows';
import type { Hit } from './store';

const hit = (index: number, page: number): Hit => ({ index, page, quads: [] });
const HITS = [hit(0, 0), hit(1, 0), hit(2, 3), hit(3, 7), hit(4, 7), hit(5, 7)];

describe('buildRows', () => {
  it('puts a 24 px header before the hits of each page and a 48 px row per hit', () => {
    const { rows, tops, rowOfHit } = buildRows(HITS, 24, 48);
    expect(rows.map((row) => (row.kind === 'page' ? `p${row.page}` : `h${row.hit}`))).toEqual([
      'p0',
      'h0',
      'h1',
      'p3',
      'h2',
      'p7',
      'h3',
      'h4',
      'h5',
    ]);
    expect(Array.from(tops)).toEqual([0, 24, 72, 120, 144, 192, 216, 264, 312, 360]);
    expect(Array.from(rowOfHit)).toEqual([1, 2, 4, 6, 7, 8]);
  });

  it('is empty without hits', () => {
    const { rows, tops } = buildRows([], 24, 48);
    expect(rows).toEqual([]);
    expect(Array.from(tops)).toEqual([0]);
  });
});

describe('rowRange', () => {
  const { tops } = buildRows(HITS, 24, 48);

  it('mounts the rows that meet the viewport and the overscan around them', () => {
    expect(rowRange(tops, 0, 100, 0)).toEqual({ first: 0, last: 2 });
    expect(rowRange(tops, 130, 60, 0)).toEqual({ first: 3, last: 4 });
    expect(rowRange(tops, 130, 60, 1)).toEqual({ first: 2, last: 5 });
  });

  it('stays inside the list, also when scrolled past the end or with nothing to show', () => {
    expect(rowRange(tops, 5000, 100, 2)).toEqual({ first: 6, last: 8 });
    expect(rowRange(tops, 0, 100000, 3)).toEqual({ first: 0, last: 8 });
    expect(rowRange(new Float64Array(1), 0, 100, 2)).toBeNull();
  });
});
