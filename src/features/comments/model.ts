import type { AnnotationKind, AnnotationSummary } from '../../api/annotations';

/**
 * The comments list as pure data (DESIGN 3.26): threads from the summaries (a root and the replies that point at it, directly or
 * through other replies), the filter, the sort and the flat rows the tree shows. Everything here is arithmetic on the summaries, so
 * a document with 20 000 annotations costs a few passes.
 */

export type SortOrder = 'page' | 'newest' | 'oldest';
export const SORT_ORDERS: readonly SortOrder[] = ['page', 'newest', 'oldest'];

export interface Thread {
  root: AnnotationSummary;
  /** Oldest first. */
  replies: readonly AnnotationSummary[];
  /** The newest time in the thread (ms), 0 if none of it has a date. */
  latest: number;
}

export interface Filter {
  /** Kinds to show; empty means all. */
  kinds: readonly AnnotationKind[];
  /** Authors to show (`''` is "no author"); empty means all. */
  authors: readonly string[];
}

export const NO_FILTER: Filter = { kinds: [], authors: [] };

export const isFiltering = (filter: Filter) => filter.kinds.length > 0 || filter.authors.length > 0;

/**
 * A date of the file as milliseconds: ISO 8601 (what the app writes) or a PDF date (`D:YYYYMMDDHHmmSS` with an optional zone).
 * `null` when it is neither.
 */
export function parseDate(text: string | null): number | null {
  if (text === null) return null;
  const pdf = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(\d{2})?'?)?/.exec(text);
  if (pdf !== null) {
    const [, y, mo, d, h, mi, s, , sign, zh, zm] = pdf;
    const offset = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (Number(zh) * 60 + Number(zm ?? 0));
    const time = Date.UTC(
      Number(y),
      Number(mo ?? 1) - 1,
      Number(d ?? 1),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
    );
    return Number.isFinite(time) ? time - offset * 60_000 : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

/** Groups the summaries into threads in the order of the roots as they come. A reply whose target is missing is a root. */
export function buildThreads(summaries: readonly AnnotationSummary[]): Thread[] {
  const byId = new Map<number, AnnotationSummary>();
  for (const summary of summaries) byId.set(summary.id, summary);
  /** The root of a summary; a cycle (a hostile file) is rooted at its smallest id. */
  const rootOf = (summary: AnnotationSummary): AnnotationSummary => {
    const seen = new Set<number>([summary.id]);
    let current = summary;
    while (current.inReplyTo !== null) {
      const parent = byId.get(current.inReplyTo);
      if (parent === undefined) break;
      if (seen.has(parent.id)) {
        // A cycle: the member with the smallest id is the root, for every member of it.
        const smallest = Math.min(...seen);
        return byId.get(smallest) ?? current;
      }
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const threads = new Map<number, { root: AnnotationSummary; replies: AnnotationSummary[] }>();
  for (const summary of summaries) {
    const root = rootOf(summary);
    let thread = threads.get(root.id);
    if (thread === undefined) {
      thread = { root, replies: [] };
      threads.set(root.id, thread);
    }
    if (root.id !== summary.id) thread.replies.push(summary);
  }
  return [...threads.values()].map(({ root, replies }) => {
    const dated = (s: AnnotationSummary) => parseDate(s.modified) ?? 0;
    replies.sort((a, b) => dated(a) - dated(b) || a.id - b.id);
    return { root, replies, latest: Math.max(dated(root), ...replies.map(dated)) };
  });
}

const matches = (summary: AnnotationSummary, filter: Filter) =>
  (filter.kinds.length === 0 || filter.kinds.includes(summary.kind)) &&
  (filter.authors.length === 0 || filter.authors.includes(summary.author ?? ''));

/** The threads of which any member passes the filter. */
export function filterThreads(threads: readonly Thread[], filter: Filter): Thread[] {
  if (!isFiltering(filter)) return [...threads];
  return threads.filter((thread) => matches(thread.root, filter) || thread.replies.some((r) => matches(r, filter)));
}

export function sortThreads(threads: readonly Thread[], order: SortOrder): Thread[] {
  const sorted = [...threads];
  if (order === 'page') {
    sorted.sort((a, b) => a.root.pageId - b.root.pageId || a.root.id - b.root.id);
  } else {
    const sign = order === 'newest' ? -1 : 1;
    // Threads without a date go last either way.
    sorted.sort((a, b) => {
      if ((a.latest === 0) !== (b.latest === 0)) return a.latest === 0 ? 1 : -1;
      return sign * (a.latest - b.latest) || a.root.id - b.root.id;
    });
  }
  return sorted;
}

/** The kinds and authors present, for the filter popover. Kinds in the order of first appearance; authors sorted, `''` first. */
export function facets(summaries: readonly AnnotationSummary[]): { kinds: AnnotationKind[]; authors: string[] } {
  const kinds = new Set<AnnotationKind>();
  const authors = new Set<string>();
  for (const s of summaries) {
    kinds.add(s.kind);
    authors.add(s.author ?? '');
  }
  return { kinds: [...kinds], authors: [...authors].sort((a, b) => a.localeCompare(b)) };
}

export type Row =
  | { type: 'group'; key: string; pageId: number }
  | {
      type: 'root';
      key: string;
      summary: AnnotationSummary;
      replyCount: number;
      expanded: boolean | undefined;
      posinset: number;
      setsize: number;
    }
  | { type: 'reply'; key: string; summary: AnnotationSummary; root: number; posinset: number; setsize: number };

/** The flat rows: a group header per page when sorted by page, each thread's root, and its replies if the root is expanded. */
export function buildRows(threads: readonly Thread[], order: SortOrder, expanded: ReadonlySet<number>): Row[] {
  const rows: Row[] = [];
  let page = -1;
  for (const [position, thread] of threads.entries()) {
    if (order === 'page' && thread.root.pageId !== page) {
      page = thread.root.pageId;
      rows.push({ type: 'group', key: `g${page}`, pageId: page });
    }
    const open = thread.replies.length === 0 ? undefined : expanded.has(thread.root.id);
    rows.push({
      type: 'root',
      key: `a${thread.root.id}`,
      summary: thread.root,
      replyCount: thread.replies.length,
      expanded: open,
      posinset: position + 1,
      setsize: threads.length,
    });
    if (open === true) {
      for (const [at, reply] of thread.replies.entries()) {
        rows.push({
          type: 'reply',
          key: `a${reply.id}`,
          summary: reply,
          root: thread.root.id,
          posinset: at + 1,
          setsize: thread.replies.length,
        });
      }
    }
  }
  return rows;
}

/** Top offsets of the rows (plus the total as the last entry) for rows of the given heights. */
export function offsetsOf(rows: readonly Row[], heights: { group: number; root: number; reply: number }): number[] {
  const offsets: number[] = [0];
  let top = 0;
  for (const row of rows) {
    top += heights[row.type];
    offsets.push(top);
  }
  return offsets;
}

/** The rows (first and last index) that overlap `[scrollTop - overscan, scrollTop + box + overscan]`; `null` for no rows. */
export function windowOf(
  offsets: readonly number[],
  scrollTop: number,
  box: number,
  overscanPx: number,
): { first: number; last: number } | null {
  const count = offsets.length - 1;
  if (count <= 0 || box <= 0) return null;
  const from = Math.max(0, scrollTop - overscanPx);
  const to = scrollTop + box + overscanPx;
  // Last row whose top is <= from.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] as number) <= from) lo = mid;
    else hi = mid - 1;
  }
  const first = lo;
  let last = first;
  while (last + 1 < count && (offsets[last + 1] as number) < to) last += 1;
  return { first, last };
}
