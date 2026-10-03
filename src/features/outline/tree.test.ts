import { describe, expect, it } from 'vitest';

import type { OutlineNode } from '../../api/outline';
import {
  buildIndex,
  currentNode,
  expandSiblings,
  initialExpansion,
  rowsOf,
  treeKey,
  typeAheadRow,
  visibleAncestor,
  visibleRows,
  windowRange,
} from './tree';

const leaf = (title: string, page?: number, y = 0): OutlineNode => ({
  title,
  target: page === undefined ? null : { pageId: page, y },
  children: [],
});
const parent = (title: string, page: number | undefined, ...children: OutlineNode[]): OutlineNode => ({
  ...leaf(title, page),
  children,
});

// 0 A(p0) / 1 A1(p0 y100) / 2 A2(p1) / 3 A2a(p2) / 4 B(p3) / 5 C(none, leaf)
const SAMPLE = [parent('A', 0, leaf('A1', 0, 100), parent('A2', 1, leaf('A2a', 2))), parent('B', 3), leaf('C')];

describe('buildIndex', () => {
  const index = buildIndex(SAMPLE);
  it('flattens in document order with levels and sets', () => {
    expect(index.titles).toEqual(['A', 'A1', 'A2', 'A2a', 'B', 'C']);
    expect([...index.level]).toEqual([1, 2, 2, 3, 1, 1]);
    expect([...index.parent]).toEqual([-1, 0, 0, 2, -1, -1]);
    expect([...index.end]).toEqual([4, 2, 4, 4, 5, 6]);
    expect([...index.posinset]).toEqual([1, 1, 2, 1, 2, 3]);
    expect([...index.setsize]).toEqual([3, 2, 2, 1, 3, 3]);
  });
  it('handles an empty outline', () => {
    expect(buildIndex([]).count).toBe(0);
  });
});

describe('visibleRows', () => {
  const index = buildIndex(SAMPLE);
  it('shows the top level when nothing is expanded', () => {
    expect([...visibleRows(index, new Set())]).toEqual([0, 4, 5]);
  });
  it('shows an expanded branch, nested ones only when expanded too', () => {
    expect([...visibleRows(index, new Set([0]))]).toEqual([0, 1, 2, 4, 5]);
    expect([...visibleRows(index, new Set([0, 2]))]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...visibleRows(index, new Set([2]))]).toEqual([0, 4, 5]);
  });
});

describe('initialExpansion', () => {
  it('expands the ancestors of the current node', () => {
    const index = buildIndex(SAMPLE);
    expect([...initialExpansion(index, 3)].sort()).toEqual([0, 2]);
  });
  it('expands a single top-level parent', () => {
    const index = buildIndex([SAMPLE[0] as OutlineNode]);
    expect([...initialExpansion(index, -1)]).toEqual([0]);
  });
  it('expands nothing for several top-level nodes and no current node', () => {
    expect(initialExpansion(buildIndex(SAMPLE), -1).size).toBe(0);
  });
  it('keeps the revealed rows within the cap, the current branch first', () => {
    const wide = (name: string, count: number) =>
      parent(name, 0, ...Array.from({ length: count }, (_, n) => leaf(`${name}${n}`, 0)));
    const index = buildIndex([wide('X', 150), wide('Y', 100)]);
    // Opening X makes 152 rows; opening Y as well would make 252. The current node is in Y.
    const expanded = initialExpansion(index, index.count - 1);
    expect(visibleRows(index, expanded).length).toBeLessThanOrEqual(200);
    expect(expanded.has(151)).toBe(true);
    expect(expanded.has(0)).toBe(false);
  });
});

describe('expandSiblings', () => {
  it('opens every sibling that has children', () => {
    const index = buildIndex([parent('P', 0, leaf('x', 0)), parent('Q', 1, leaf('y', 1)), leaf('R', 2)]);
    expect([...expandSiblings(index, new Set(), 0)].sort()).toEqual([0, 2]);
  });
  it('stops at the cap', () => {
    const big = (name: string) => parent(name, 0, ...Array.from({ length: 150 }, (_, n) => leaf(`${name}${n}`, 0)));
    const index = buildIndex([big('P'), big('Q')]);
    expect(visibleRows(index, expandSiblings(index, new Set(), 0)).length).toBeLessThanOrEqual(200);
  });
});

describe('current section', () => {
  const index = buildIndex(SAMPLE);
  it('is the last node whose target is at or before the reading position', () => {
    expect(currentNode(index, { page: 0, y: 0 })).toBe(0);
    expect(currentNode(index, { page: 0, y: 99 })).toBe(0);
    expect(currentNode(index, { page: 0, y: 100 })).toBe(1);
    expect(currentNode(index, { page: 1, y: 0 })).toBe(2);
    expect(currentNode(index, { page: 2, y: 500 })).toBe(3);
    expect(currentNode(index, { page: 9, y: 0 })).toBe(4);
  });
  it('is none above the first target and for an outline without targets', () => {
    expect(currentNode(buildIndex([leaf('x', 3)]), { page: 2, y: 0 })).toBe(-1);
    expect(currentNode(buildIndex([leaf('x')]), { page: 2, y: 0 })).toBe(-1);
  });
  it('prefers the later node when two share a place', () => {
    expect(currentNode(buildIndex([leaf('a', 1, 5), leaf('b', 1, 5)]), { page: 1, y: 5 })).toBe(1);
  });
  it('maps a node in a collapsed branch to its nearest visible ancestor', () => {
    const rows = visibleRows(index, new Set());
    const rowOf = rowsOf(index, rows);
    expect(visibleAncestor(index, rowOf, 3)).toBe(0);
    expect(visibleAncestor(index, rowOf, 4)).toBe(4);
  });
});

describe('treeKey', () => {
  const index = buildIndex(SAMPLE);
  const run = (key: string, expanded: number[], row: number, rtl = false) => {
    const set = new Set(expanded);
    const rows = visibleRows(index, set);
    return treeKey(key, index, rows, rowsOf(index, rows), set, row, rtl);
  };
  it('moves with Up, Down, Home and End, without wrapping', () => {
    expect(run('ArrowDown', [], 0)).toEqual({ type: 'focus', row: 1 });
    expect(run('ArrowDown', [], 2)).toBeNull();
    expect(run('ArrowUp', [], 0)).toBeNull();
    expect(run('Home', [], 2)).toEqual({ type: 'focus', row: 0 });
    expect(run('End', [], 0)).toEqual({ type: 'focus', row: 2 });
  });
  it('Right expands a collapsed parent, then enters it; a leaf does nothing', () => {
    expect(run('ArrowRight', [], 0)).toEqual({ type: 'expand', node: 0 });
    expect(run('ArrowRight', [0], 0)).toEqual({ type: 'focus', row: 1 });
    expect(run('ArrowRight', [], 2)).toBeNull();
  });
  it('Left collapses an expanded parent, else goes to the parent', () => {
    expect(run('ArrowLeft', [0], 0)).toEqual({ type: 'collapse', node: 0 });
    expect(run('ArrowLeft', [0], 1)).toEqual({ type: 'focus', row: 0 });
    expect(run('ArrowLeft', [], 0)).toBeNull();
  });
  it('mirrors Left and Right in a right-to-left tree', () => {
    expect(run('ArrowLeft', [], 0, true)).toEqual({ type: 'expand', node: 0 });
  });
  it('Enter and Space activate, * expands the siblings', () => {
    expect(run('Enter', [], 1)).toEqual({ type: 'activate', node: 4 });
    expect(run(' ', [], 0)).toEqual({ type: 'activate', node: 0 });
    expect(run('*', [], 0)).toEqual({ type: 'expandSiblings', node: 0 });
    expect(run('x', [], 0)).toBeNull();
  });
});

describe('typeAheadRow', () => {
  const index = buildIndex([leaf('Alpha'), leaf('Beta'), leaf('Béton'), leaf('alpine')]);
  const rows = visibleRows(index, new Set());
  it('finds the next row that starts with the buffer, case-insensitively, wrapping', () => {
    expect(typeAheadRow(index, rows, 0, 'b')).toBe(1);
    expect(typeAheadRow(index, rows, 1, 'b')).toBe(2);
    expect(typeAheadRow(index, rows, 2, 'a')).toBe(3);
    expect(typeAheadRow(index, rows, 3, 'a')).toBe(0);
  });
  it('searches from the current row for a longer buffer', () => {
    expect(typeAheadRow(index, rows, 3, 'alp')).toBe(3);
    expect(typeAheadRow(index, rows, 0, 'zz')).toBe(-1);
    expect(typeAheadRow(index, rows, 0, '')).toBe(-1);
  });
});

describe('windowRange', () => {
  it('mounts the viewport plus overscan, a bounded number of rows of 10 000', () => {
    const range = windowRange(32 * 5000, 640, 10_000, 32, 8);
    expect(range).toEqual({ first: 4992, last: 5027 });
  });
  it('clamps at both ends and for an empty list', () => {
    expect(windowRange(0, 640, 10_000, 32, 8)?.first).toBe(0);
    expect(windowRange(32 * 9990, 640, 10_000, 32, 8)?.last).toBe(9999);
    expect(windowRange(0, 640, 0, 32)).toBeNull();
  });
});

describe('expandSiblings at scale', () => {
  it('handles 10 000 top-level parents quickly and stops at the cap', () => {
    const many = Array.from({ length: 10_000 }, (_, n) => parent(`P${n}`, 0, leaf('c', 0), leaf('d', 0)));
    const index = buildIndex(many);
    const started = performance.now();
    const expanded = expandSiblings(index, new Set(), 0);
    expect(performance.now() - started).toBeLessThan(500);
    expect(expanded.size).toBe(0);
  });
});
