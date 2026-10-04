import { CircleAlert, LoaderCircle, MessagesSquare } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { Button } from '../../components';
import { Icon } from '../../components/Icon';
import { tokenPx } from '../../components/tokens';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageNumberOf } from '../../stores/pages';
import { deleteThread, jumpTo } from './actions';
import { CommentCard } from './CommentCard';
import {
  NO_FILTER,
  buildRows,
  filterThreads,
  isFiltering,
  offsetsOf,
  sortThreads,
  windowOf,
  type Row,
  type Thread,
} from './model';
import { DEFAULT_VIEW, useComments, type CommentsEntry } from './store';
import { CommentsFilter } from './CommentsFilter';
import { REFRESH_DELAY_MS, useCommentsData } from './useCommentsData';

/** The loading state shows nothing for this long. */
export const LOADING_SHOWN_AFTER_MS = 300;
export { REFRESH_DELAY_MS };
/** Pixels mounted beyond the viewport on each side. */
const OVERSCAN_PX = 256;
/** The relative times of the cards are fresh to the minute. */
const CLOCK_MS = 60_000;

const HEIGHT_FALLBACK = { group: 24, card: 112 } as const;

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center gap-2 p-6 text-center">{children}</div>;
}

/** The loading state: nothing for 300 ms, then a spinner and a line (`role=status`). */
function Loading() {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADING_SHOWN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div role="status">
      {shown && (
        <Message>
          <Icon icon={LoaderCircle} className="animate-spin motion-reduce:animate-none" />
          <span className="text-sm text-text-muted">{t('comments.loading')}</span>
        </Message>
      )}
    </div>
  );
}

type Ready = Extract<CommentsEntry, { status: 'ready' }>;

/** A row of the list: placed at its offset, its height measured (a card has no fixed height). */
function Slot({
  rowKey,
  top,
  measure,
  children,
}: {
  rowKey: string;
  top: number;
  measure: { observe: (element: HTMLElement) => () => void };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    return element === null ? undefined : measure.observe(element);
  }, [measure]);
  return (
    <div ref={ref} data-row-key={rowKey} className="absolute inset-x-0 box-border pb-2" style={{ top }}>
      {children}
    </div>
  );
}

/** The list of a loaded comments list: cards, virtualized with measured heights (overscan), one tab stop, roving Up/Down. */
export function CommentsList({ docId, entry }: { docId: number; entry: Ready }) {
  const t = useT();
  const view = useComments((state) => state.views[docId]) ?? DEFAULT_VIEW;
  const editing = useComments((state) => state.editing[docId]);
  const selectedIds = useAnnotations((state) => state.selectedIds[docId]);
  const [base] = useState(() => ({
    group: tokenPx('--comments-group-height', HEIGHT_FALLBACK.group) + tokenPx('--space-2', 8),
    card: tokenPx('--comments-card-estimate', HEIGHT_FALLBACK.card) + tokenPx('--space-2', 8),
  }));
  const threads = useMemo(
    () => sortThreads(filterThreads(entry.threads, view.filter, (pageId) => pageNumberOf(docId, pageId)), view.order),
    [entry.threads, view.filter, view.order, docId],
  );
  const rows = useMemo(() => buildRows(threads, view.order), [threads, view.order]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Measured heights: one observer for every mounted row. A change of a height renders the offsets again.
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const observer = useRef<ResizeObserver | null>(null);
  const tracker = useMemo(() => {
    const note = (changes: [string, number][]) =>
      setHeights((before) => {
        const next = new Map(before);
        let any = false;
        for (const [key, height] of changes) {
          if (height > 0 && next.get(key) !== height) {
            next.set(key, height);
            any = true;
          }
        }
        return any ? next : before;
      });
    return {
      observe: (element: HTMLElement) => {
        note([[element.dataset.rowKey ?? '', element.getBoundingClientRect().height]]);
        observer.current ??= new ResizeObserver((entries) => {
          note(
            entries.map((item) => [
              (item.target as HTMLElement).dataset.rowKey ?? '',
              item.borderBoxSize?.[0]?.blockSize ?? (item.target as HTMLElement).offsetHeight,
            ]),
          );
        });
        observer.current.observe(element);
        return () => observer.current?.unobserve(element);
      },
    };
  }, []);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  const offsets = useMemo(
    () => offsetsOf(rows, (row) => heights.get(row.key) ?? (row.type === 'group' ? base.group : base.card)),
    [rows, base, heights],
  );
  const rowIndexOf = useMemo(() => new Map(rows.map((row, i) => [row.key, i])), [rows]);

  useEffect(() => {
    const region = scrollerRef.current;
    if (region === null) return;
    const watcher = new ResizeObserver(() => setBox(region.clientHeight));
    watcher.observe(region);
    return () => watcher.disconnect();
  }, []);

  /** Scrolls the region so that row `index` is whole in view (nearest). */
  const reveal = useCallback(
    (index: number) => {
      const region = scrollerRef.current;
      const top = offsets[index];
      const bottom = offsets[index + 1];
      if (region === null || top === undefined || bottom === undefined) return;
      if (top < region.scrollTop) region.scrollTop = top;
      else if (bottom > region.scrollTop + region.clientHeight) region.scrollTop = bottom - region.clientHeight;
      setScrollTop(region.scrollTop);
    },
    [offsets],
  );

  // A selection made on the canvas: its card comes into view.
  const selectedFirst = selectedIds?.[0];
  const selectedRoot = useMemo(() => {
    if (selectedFirst === undefined) return undefined;
    return entry.threads.find((th) => th.root.id === selectedFirst || th.replies.some((r) => r.id === selectedFirst))
      ?.root.id;
  }, [selectedFirst, entry.threads]);
  useEffect(() => {
    if (selectedRoot === undefined) return;
    const index = rowIndexOf.get(`a${selectedRoot}`);
    if (index !== undefined) reveal(index);
  }, [selectedRoot, rowIndexOf, reveal]);

  // A new comment being written: its card comes into view once it is in the list.
  const revealedEdit = useRef<number | null>(null);
  useEffect(() => {
    if (editing === null || editing === undefined) {
      revealedEdit.current = null;
      return;
    }
    if (revealedEdit.current === editing.id) return;
    const index = rowIndexOf.get(`a${editing.id}`);
    if (index === undefined) return;
    revealedEdit.current = editing.id;
    reveal(index);
  }, [editing, rowIndexOf, reveal]);

  const cardIndexes = useMemo(() => rows.flatMap((row, i) => (row.type === 'card' ? [i] : [])), [rows]);
  const step = useCallback(
    (from: number, direction: 1 | -1): number => {
      for (let i = from + direction; i >= 0 && i < rows.length; i += direction) if (rows[i]?.type === 'card') return i;
      return -1;
    },
    [rows],
  );

  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row === undefined || row.type !== 'card') return;
      reveal(index);
      setFocusKey(row.key);
      pendingFocus.current = row.key;
      const element = scrollerRef.current?.querySelector<HTMLElement>(`article[data-key="${row.key}"]`);
      if (element !== null && element !== undefined) {
        element.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    },
    [rows, reveal],
  );

  // A card that was asked to take the focus and was not mounted yet takes it once it is.
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === null) return;
    const element = scrollerRef.current?.querySelector<HTMLElement>(`article[data-key="${wanted}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const activate = useCallback(
    (thread: Thread) => {
      setFocusKey(`a${thread.root.id}`);
      // Focus stays where it is: in the list. The page loads first, so the selection has its annotation.
      jumpTo(docId, thread.root.pageId, thread.root.id);
    },
    [docId],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    // Only the card itself has these keys; its fields and buttons keep theirs.
    const item = event.target instanceof HTMLElement && event.target.tagName === 'ARTICLE' ? event.target : null;
    const index = rowIndexOf.get(item?.dataset.key ?? '');
    const row = index === undefined ? undefined : rows[index];
    if (item === null || index === undefined || row === undefined || row.type !== 'card') return;
    let handled = true;
    if (event.key === 'ArrowDown') {
      const next = step(index, 1);
      if (next >= 0) focusRow(next);
    } else if (event.key === 'ArrowUp') {
      const previous = step(index, -1);
      if (previous >= 0) focusRow(previous);
    } else if (event.key === 'Home') {
      focusRow(step(-1, 1));
    } else if (event.key === 'End') {
      focusRow(step(rows.length, -1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      activate(row.thread);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      const { root, replies, states } = row.thread;
      if (root.kind !== 'opaque') {
        const next = step(index, 1);
        const fallback = next >= 0 ? next : step(index, -1);
        void deleteThread(docId, [root.id, ...replies.map((r) => r.id), ...states.map((s) => s.id)]).then((done) =>
          done && fallback >= 0 ? focusRow(fallback) : undefined,
        );
      }
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  };

  // The tab stop: the focused card, else the selected one, else the first.
  const tabKey = useMemo(() => {
    for (const key of [focusKey, selectedRoot === undefined ? null : `a${selectedRoot}`]) {
      if (key !== null && rowIndexOf.has(key)) return key;
    }
    const first = cardIndexes[0];
    return first === undefined ? null : (rows[first]?.key ?? null);
  }, [focusKey, selectedRoot, rowIndexOf, rows, cardIndexes]);

  const range = windowOf(offsets, scrollTop, box, OVERSCAN_PX);
  const mounted = useMemo(() => {
    const set = new Set<number>();
    if (range !== null) for (let i = range.first; i <= range.last; i += 1) set.add(i);
    for (const key of [tabKey, focusKey, editing === null || editing === undefined ? null : `a${editing.id}`]) {
      const i = key === null ? undefined : rowIndexOf.get(key);
      if (i !== undefined) set.add(i);
    }
    return [...set].sort((a, b) => a - b);
  }, [range?.first, range?.last, tabKey, focusKey, editing, rowIndexOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = entry.threads.length;

  if (threads.length === 0) {
    return (
      <Message>
        <span className="text-sm text-text-muted">{t('comments.noMatch')}</span>
        <Button size="sm" variant="ghost" onClick={() => useComments.getState().setFilter(docId, NO_FILTER)}>
          {t('comments.reset')}
        </Button>
      </Message>
    );
  }

  return (
    <>
      {isFiltering(view.filter) && (
        <p className="t-caption m-0 flex items-center gap-1 px-3 pb-1">
          <span>{t('comments.filtered', { shown: threads.length, total })}</span>
          <span aria-hidden="true">·</span>
          <Button size="sm" variant="ghost" onClick={() => useComments.getState().setFilter(docId, NO_FILTER)}>
            {t('comments.resetShort')}
          </Button>
        </p>
      )}
      <div
        ref={scrollerRef}
        onScroll={(event) => {
          // Only a change of the mounted window renders the list again.
          const top = event.currentTarget.scrollTop;
          setScrollTop((previous) => {
            const before = windowOf(offsets, previous, box, OVERSCAN_PX);
            const after = windowOf(offsets, top, box, OVERSCAN_PX);
            return before?.first === after?.first && before?.last === after?.last ? previous : top;
          });
        }}
        className="min-h-0 flex-auto overflow-x-hidden overflow-y-auto px-3 pt-2 pb-3 [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <div
          role="list"
          aria-label={t('comments.list')}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const item = event.target instanceof Element ? event.target.closest<HTMLElement>('article') : null;
            if (item?.dataset.key !== undefined) setFocusKey(item.dataset.key);
          }}
          onBlur={(event) => {
            if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
              setFocusKey(null);
          }}
          className="relative"
          style={{ height: offsets[offsets.length - 1] }}
        >
          {mounted.map((i) => {
            const row = rows[i] as Row;
            const top = offsets[i] as number;
            if (row.type === 'group') {
              return (
                <Slot key={row.key} rowKey={row.key} top={top} measure={tracker}>
                  <div
                    aria-hidden="true"
                    className="flex h-control-sm items-center px-1 text-sm font-semibold text-text-muted"
                  >
                    {t('search.page', { n: pageNumberOf(docId, row.pageId) })}
                  </div>
                </Slot>
              );
            }
            const selected = selectedRoot === row.thread.root.id;
            return (
              <Slot key={row.key} rowKey={row.key} top={top} measure={tracker}>
                <div role="listitem" aria-posinset={row.posinset} aria-setsize={row.setsize}>
                  <CommentCard
                    docId={docId}
                    thread={row.thread}
                    selected={selected}
                    tabStop={tabKey === row.key}
                    now={now}
                    onActivate={activate}
                  />
                </div>
              </Slot>
            );
          })}
        </div>
      </div>
    </>
  );
}

function CommentsView({ docId }: { docId: number }) {
  const t = useT();
  const entry = useComments((state) => state.byDoc[docId]);
  // Live from the change sets: the list is read again once the changes have settled. The first read is at once.
  useCommentsData(docId, true);

  if (entry === undefined || entry.status === 'loading') return <Loading />;
  if (entry.status === 'error') {
    return (
      <Message>
        <div role="alert" className="flex flex-col items-center gap-2">
          <Icon icon={CircleAlert} className="text-error-text" />
          <span className="text-md">{t('comments.error')}</span>
        </div>
        <Button size="sm" onClick={() => useComments.getState().load(docId)}>
          {t('comments.retry')}
        </Button>
      </Message>
    );
  }
  if (entry.summaries.length === 0) {
    return (
      <Message>
        <span className="flex size-control-md items-center justify-center rounded-sm bg-tile text-tile-icon">
          <Icon icon={MessagesSquare} />
        </span>
        <span className="text-md font-semibold">{t('comments.empty')}</span>
        <span className="text-sm text-text-muted">{t('comments.emptyHint')}</span>
      </Message>
    );
  }
  return (
    <>
      <CommentsFilter docId={docId} summaries={entry.summaries} />
      <CommentsList docId={docId} entry={entry} />
    </>
  );
}

/** The Comments tab's content. Another document is another list: its view, scroll and focus are its own. */
export function Comments() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  if (docId === null) return <p className="m-0 text-sm text-text-muted">{t('leftPanel.empty.comments')}</p>;
  return <CommentsView key={docId} docId={docId} />;
}
