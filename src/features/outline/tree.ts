import type { OutlineNode, OutlineTarget } from '../../api/outline';

/**
 * The outline as one flat index (DESIGN 3.15): nodes in document order (pre-order), so a node's children follow it and its
 * subtree is the range up to `end`. Everything the tree needs (visible rows, positions, the current section) is arithmetic on
 * these arrays, so a 10 000 node outline costs one pass per load and one per expansion change.
 */
export interface OutlineIndex {
  count: number;
  titles: readonly string[];
  targets: readonly (OutlineTarget | null)[];
  /** Parent node, -1 at the top level. */
  parent: Int32Array;
  /** 1 for the top level. */
  level: Uint8Array;
  /** Number of direct children. */
  childCount: Int32Array;
  /** End of the subtree (exclusive), in node numbers. */
  end: Int32Array;
  /** 1-based place among the siblings, and how many siblings there are. */
  posinset: Int32Array;
  setsize: Int32Array;
  /** Nodes that have a target, sorted by (page, y, document order): the lookup of the current section. */
  sorted: Int32Array;
}

/** Most rows revealed by the initial expansion and by expanding siblings. */
export const MAX_INITIAL_ROWS = 200;

export function buildIndex(roots: readonly OutlineNode[]): OutlineIndex {
  const titles: string[] = [];
  const targets: (OutlineTarget | null)[] = [];
  const parent: number[] = [];
  const level: number[] = [];
  const childCount: number[] = [];
  const end: number[] = [];
  const posinset: number[] = [];
  const setsize: number[] = [];

  const walk = (nodes: readonly OutlineNode[], parentId: number, depth: number) => {
    nodes.forEach((node, position) => {
      const id = titles.length;
      titles.push(node.title);
      targets.push(node.target);
      parent.push(parentId);
      level.push(depth);
      childCount.push(node.children.length);
      end.push(id + 1);
      posinset.push(position + 1);
      setsize.push(nodes.length);
      walk(node.children, id, depth + 1);
      end[id] = titles.length;
    });
  };
  walk(roots, -1, 1);

  const withTarget: number[] = [];
  targets.forEach((target, id) => {
    if (target !== null) withTarget.push(id);
  });
  withTarget.sort((a, b) => {
    const ta = targets[a] as OutlineTarget;
    const tb = targets[b] as OutlineTarget;
    return ta.pageId - tb.pageId || ta.y - tb.y || a - b;
  });

  return {
    count: titles.length,
    titles,
    targets,
    parent: Int32Array.from(parent),
    level: Uint8Array.from(level),
    childCount: Int32Array.from(childCount),
    end: Int32Array.from(end),
    posinset: Int32Array.from(posinset),
    setsize: Int32Array.from(setsize),
    sorted: Int32Array.from(withTarget),
  };
}

/** The visible rows (node numbers, in order) for a set of expanded parents. */
export function visibleRows(index: OutlineIndex, expanded: ReadonlySet<number>): Int32Array {
  const rows: number[] = [];
  let id = 0;
  while (id < index.count) {
    rows.push(id);
    id = index.childCount[id] !== 0 && !expanded.has(id) ? (index.end[id] as number) : id + 1;
  }
  return Int32Array.from(rows);
}

/** The row of each node, `-1` for one that is not visible. */
export function rowsOf(index: OutlineIndex, rows: Int32Array): Int32Array {
  const map = new Int32Array(index.count).fill(-1);
  rows.forEach((node, row) => {
    map[node] = row;
  });
  return map;
}

/** The place the reader is at: a page and how far down it, in points. */
export interface ReadingPosition {
  page: number;
  y: number;
}

/**
 * The last node in document order whose target is at or before `reading`, `-1` if there is none (the reader is above the first
 * target). Binary search over the targets sorted by place.
 */
export function currentNode(index: OutlineIndex, reading: ReadingPosition): number {
  let low = 0;
  let high = index.sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const target = index.targets[index.sorted[middle] as number] as OutlineTarget;
    if (target.pageId < reading.page || (target.pageId === reading.page && target.y <= reading.y)) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? -1 : (index.sorted[low - 1] as number);
}

/** `node` itself if it is a visible row, else its nearest ancestor that is (a collapsed branch stands for its content). */
export function visibleAncestor(index: OutlineIndex, rowOf: Int32Array, node: number): number {
  let at = node;
  while (at >= 0 && rowOf[at] === -1) at = index.parent[at] as number;
  return at;
}

/** How many rows the expanded set reveals. */
function revealedCount(index: OutlineIndex, expanded: ReadonlySet<number>): number {
  return visibleRows(index, expanded).length;
}

/**
 * The expansion a document starts with: the top level, the ancestors of the current node, and a single top-level parent. The
 * rows revealed stay at most `cap` (the current branch first, then document order); the top level alone may exceed it.
 */
export function initialExpansion(index: OutlineIndex, current: number, cap = MAX_INITIAL_ROWS): Set<number> {
  const expanded = new Set<number>();
  const candidates: number[] = [];
  const chain: number[] = [];
  for (let at = current >= 0 ? (index.parent[current] as number) : -1; at >= 0; at = index.parent[at] as number)
    chain.push(at);
  candidates.push(...chain.reverse());
  const tops = index.count > 0 && index.setsize[0] === 1 && index.childCount[0] !== 0 ? [0] : [];
  candidates.push(...tops);
  for (const node of candidates) {
    if (expanded.has(node)) continue;
    // A node's children are revealed in full: its own children, as far as they are visible once it is open.
    const next = new Set(expanded).add(node);
    const total = revealedCount(index, next);
    if (total > cap) continue;
    expanded.add(node);
  }
  return expanded;
}

/** `expanded` plus every sibling of `node` that has children, as far as `cap` rows allow (more rows than that are never added). */
export function expandSiblings(
  index: OutlineIndex,
  expanded: ReadonlySet<number>,
  node: number,
  cap = MAX_INITIAL_ROWS,
): Set<number> {
  const next = new Set(expanded);
  const from = index.parent[node] as number;
  const first = from < 0 ? 0 : from + 1;
  const last = from < 0 ? index.count : (index.end[from] as number);
  let total = revealedCount(index, next);
  for (let id = first; id < last && total < cap; id = index.end[id] as number) {
    if (index.childCount[id] === 0 || next.has(id)) continue;
    // The rows opening `id` adds: the visible rows of its subtree (itself already counts).
    next.add(id);
    let added = -1;
    for (
      let at = id;
      at < (index.end[id] as number);
      at = index.childCount[at] !== 0 && !next.has(at) ? (index.end[at] as number) : at + 1
    )
      added += 1;
    if (total + added > cap) next.delete(id);
    else total += added;
  }
  return next;
}

/** Every parent of the outline: what "collapse all" undoes. */
export function hasParents(index: OutlineIndex): boolean {
  return index.childCount.some((count) => count > 0);
}

/** What a key does to the tree. */
export type TreeAction =
  | { type: 'focus'; row: number }
  | { type: 'expand'; node: number }
  | { type: 'collapse'; node: number }
  | { type: 'activate'; node: number }
  | { type: 'expandSiblings'; node: number };

/**
 * The WAI-ARIA tree keyboard model for the navigation keys (type-ahead is `typeAheadRow`). `row` is the focused row; `null` for a
 * key that is not one of the tree's.
 */
export function treeKey(
  key: string,
  index: OutlineIndex,
  rows: Int32Array,
  rowOf: Int32Array,
  expanded: ReadonlySet<number>,
  row: number,
  rtl = false,
): TreeAction | null {
  const node = rows[row];
  if (node === undefined) return null;
  const isParent = index.childCount[node] !== 0;
  const open = isParent && expanded.has(node);
  const opening = rtl ? 'ArrowLeft' : 'ArrowRight';
  const closing = rtl ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case 'ArrowDown':
      return row + 1 < rows.length ? { type: 'focus', row: row + 1 } : null;
    case 'ArrowUp':
      return row > 0 ? { type: 'focus', row: row - 1 } : null;
    case 'Home':
      return row > 0 ? { type: 'focus', row: 0 } : null;
    case 'End':
      return row < rows.length - 1 ? { type: 'focus', row: rows.length - 1 } : null;
    case opening:
      if (!isParent) return null;
      return open ? { type: 'focus', row: row + 1 } : { type: 'expand', node };
    case closing: {
      if (open) return { type: 'collapse', node };
      const up = index.parent[node] as number;
      return up >= 0 ? { type: 'focus', row: rowOf[up] as number } : null;
    }
    case '*':
      return { type: 'expandSiblings', node };
    case 'Enter':
    case ' ':
      return { type: 'activate', node };
    default:
      return null;
  }
}

const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Time a type-ahead buffer lives after the last key, in ms. */
export const TYPE_AHEAD_MS = 500;

/**
 * The next visible row (after `from`, wrapping; `from` itself first when the buffer has several characters) whose title starts with
 * `buffer`, compared case-insensitively by locale. `-1` if none.
 */
export function typeAheadRow(index: OutlineIndex, rows: Int32Array, from: number, buffer: string): number {
  if (buffer === '' || rows.length === 0) return -1;
  const length = buffer.length;
  const start = Array.from(buffer).length > 1 ? from : from + 1;
  for (let step = 0; step < rows.length; step += 1) {
    const row = (((start + step) % rows.length) + rows.length) % rows.length;
    const title = index.titles[rows[row] as number] as string;
    if (COLLATOR.compare(title.slice(0, length), buffer) === 0) return row;
  }
  return -1;
}

/** The mounted window of a fixed-row list: rows in view plus `overscan` on each side, as `[first, last]`, `null` when empty. */
export function windowRange(
  scrollTop: number,
  viewHeight: number,
  count: number,
  rowHeight: number,
  overscan = 8,
): { first: number; last: number } | null {
  if (count === 0 || rowHeight <= 0) return null;
  const first = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const last = Math.min(count - 1, Math.max(first, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan - 1));
  return { first, last };
}
