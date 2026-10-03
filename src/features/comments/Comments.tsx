import {
  ArrowDownUp,
  ChevronRight,
  Circle,
  CircleAlert,
  Highlighter,
  ListFilter,
  LoaderCircle,
  MessagesSquare,
  PenLine,
  Slash,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import type { AnnotationKind, AnnotationSummary } from '../../api/annotations';
import { Button, IconButton, Menu, Popover } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { tokenPx } from '../../components/tokens';
import { useT, type PlainKey, type Translate } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageNumberOf, positionOf } from '../../stores/pages';
import { rgbToCss } from '../inspector/palette';
import { useViewer } from '../viewer/useViewer';
import {
  NO_FILTER,
  SORT_ORDERS,
  buildRows,
  facets,
  filterThreads,
  isFiltering,
  offsetsOf,
  parseDate,
  sortThreads,
  windowOf,
  type Row,
  type SortOrder,
} from './model';
import { DEFAULT_VIEW, useComments, type CommentsEntry } from './store';

/** The loading state shows nothing for this long. */
export const LOADING_SHOWN_AFTER_MS = 300;
/** A change of the annotations refreshes the list this long after the last one (typing in a note changes it per key). */
export const REFRESH_DELAY_MS = 200;
/** Pixels mounted beyond the viewport on each side. */
const OVERSCAN_PX = 256;

const HEIGHT_FALLBACK = { group: 24, root: 64, reply: 48 } as const;

const KIND_ICONS: Record<AnnotationKind, LucideIcon> = {
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
  note: StickyNote,
  freeText: Type,
  ink: PenLine,
  rect: Square,
  ellipse: Circle,
  line: Slash,
  opaque: MessagesSquare,
};

const SORT_LABELS: Record<SortOrder, PlainKey> = {
  page: 'comments.byPage',
  newest: 'comments.newest',
  oldest: 'comments.oldest',
};

const kindLabel = (kind: AnnotationKind): PlainKey => `annot.type.${kind}`;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A date of the file in the user's language; `''` for one that cannot be read. */
export function formatDate(text: string | null, locale: string): string {
  const time = parseDate(text);
  if (time === null) return '';
  let format = formatters.get(locale);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    formatters.set(locale, format);
  }
  return format.format(time);
}

/** The accessible name of a row: the annotation's name (`annot.name`) and, for a root, the number of replies. */
function rowName(t: Translate, summary: AnnotationSummary, replyCount: number): string {
  const type = t(kindLabel(summary.kind));
  const n = summary.pageId + 1;
  const author = summary.author ?? '';
  const text = summary.contents.trim();
  const base =
    author === ''
      ? text === ''
        ? t('annot.nameNoAuthor', { type, n })
        : t('annot.nameNoAuthorText', { type, n, text })
      : text === ''
        ? t('annot.name', { type, author, n })
        : t('annot.nameText', { type, author, n, text });
  return replyCount > 0 ? `${base}, ${t('comments.replies', { count: replyCount })}` : base;
}

interface RowProps {
  row: Row;
  index: number;
  top: number;
  height: number;
  selected: boolean;
  tabStop: boolean;
  onActivate: (summary: AnnotationSummary) => void;
  onToggle: (root: number) => void;
}

/** One treeitem (a root or a reply) or a page header. Text from the file is rendered as text only. */
const CommentRow = memo(function CommentRow({
  row,
  index,
  top,
  height,
  selected,
  tabStop,
  onActivate,
  onToggle,
}: RowProps) {
  const t = useT();
  if (row.type === 'group') {
    return (
      <div
        aria-hidden="true"
        className="absolute inset-x-0 flex items-center px-1 text-sm font-semibold text-text-muted"
        style={{ top, height }}
      >
        {t('search.page', { n: pageNumberOf(useDocuments.getState().activeId, row.pageId) })}
      </div>
    );
  }
  const { summary } = row;
  const reply = row.type === 'reply';
  const replyCount = row.type === 'root' ? row.replyCount : 0;
  const author = summary.author ?? '';
  const date = formatDate(summary.modified, t.locale);
  return (
    <div
      role="treeitem"
      aria-level={reply ? 2 : 1}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-expanded={row.type === 'root' ? row.expanded : undefined}
      aria-selected={selected}
      aria-label={rowName(t, summary, replyCount)}
      data-key={row.key}
      data-index={index}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onActivate(summary)}
      className={cx(
        'absolute inset-x-0 box-border flex cursor-pointer select-none items-start gap-0-5 rounded-sm p-1 text-md',
        selected
          ? 'bg-selected forced-colors:outline-2 forced-colors:outline-[Highlight]'
          : 'hover:bg-control-hover active:bg-control-pressed',
      )}
      style={{ top, height, paddingInlineStart: reply ? 'calc(var(--space-1) + var(--outline-indent))' : undefined }}
    >
      <span
        aria-hidden="true"
        onClick={
          row.type === 'root' && row.expanded !== undefined
            ? (event: MouseEvent) => {
                // The chevron toggles without jumping.
                event.stopPropagation();
                onToggle(summary.id);
              }
            : undefined
        }
        className="flex h-icon-16 w-icon-16 shrink-0 items-center justify-center"
      >
        {row.type === 'root' && row.expanded !== undefined && (
          <Icon
            icon={ChevronRight}
            className={cx(
              'transition-transform duration-fast motion-reduce:transition-none forced-colors:text-[CanvasText]',
              row.expanded ? 'rotate-90' : 'rtl:-scale-x-100',
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col" aria-hidden="true">
        <span className="flex h-icon-16 items-center gap-0-5">
          {!reply && (
            <>
              <span
                className="size-comments-dot shrink-0 rounded-pill forced-color-adjust-none forced-colors:ring-1 forced-colors:ring-[CanvasText]"
                style={{ backgroundColor: rgbToCss(summary.color) }}
              />
              <Icon icon={KIND_ICONS[summary.kind]} className="text-text-muted" />
            </>
          )}
          <span className={cx('min-w-0 flex-1 truncate font-semibold', author === '' && 'text-text-muted')}>
            {author === '' ? t('comments.noAuthor') : author}
          </span>
          {date !== '' && <span className="shrink-0 text-sm text-text-muted">{date}</span>}
        </span>
        <span
          className={cx(
            'text-sm break-words',
            reply || replyCount > 0 ? 'line-clamp-1' : 'line-clamp-2',
            summary.contents.trim() === '' && 'text-text-muted',
          )}
        >
          {summary.contents.trim() === '' ? t(kindLabel(summary.kind)) : summary.contents}
        </span>
        {replyCount > 0 && (
          <span className="text-sm text-text-muted">{t('comments.replies', { count: replyCount })}</span>
        )}
      </span>
    </div>
  );
});

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-1 p-3 text-center">{children}</div>;
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

/** The tree of a loaded list: virtualized (rows of three fixed heights), one tab stop, the WAI-ARIA keyboard model. */
export function CommentsTree({ docId, entry }: { docId: number; entry: Ready }) {
  const t = useT();
  const view = useComments((state) => state.views[docId]) ?? DEFAULT_VIEW;
  const selectedIds = useAnnotations((state) => state.selectedIds[docId]);
  const [heights] = useState(() => ({
    group: tokenPx('--comments-group-height', HEIGHT_FALLBACK.group),
    root: tokenPx('--comments-root-height', HEIGHT_FALLBACK.root),
    reply: tokenPx('--comments-reply-height', HEIGHT_FALLBACK.reply),
  }));
  const threads = useMemo(
    () => sortThreads(filterThreads(entry.threads, view.filter), view.order),
    [entry.threads, view.filter, view.order],
  );
  const rows = useMemo(() => buildRows(threads, view.order, view.expanded), [threads, view.order, view.expanded]);
  const offsets = useMemo(() => offsetsOf(rows, heights), [rows, heights]);
  const rowIndexOf = useMemo(() => new Map(rows.map((row, i) => [row.key, i])), [rows]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    const region = scrollerRef.current;
    if (region === null) return;
    const observer = new ResizeObserver(() => setBox(region.clientHeight));
    observer.observe(region);
    return () => observer.disconnect();
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

  // A selection made on the canvas: its row comes into view (a reply opens its thread first).
  const selectedFirst = selectedIds?.[0];
  useEffect(() => {
    if (selectedFirst === undefined) return;
    const thread = entry.threads.find(
      (th) => th.root.id === selectedFirst || th.replies.some((r) => r.id === selectedFirst),
    );
    if (thread !== undefined && thread.root.id !== selectedFirst) useComments.getState().expand(docId, thread.root.id);
  }, [selectedFirst, entry.threads, docId]);
  useEffect(() => {
    if (selectedFirst === undefined) return;
    const index = rowIndexOf.get(`a${selectedFirst}`);
    if (index !== undefined) reveal(index);
  }, [selectedFirst, rowIndexOf, reveal]);

  const isNav = (row: Row | undefined): row is Exclude<Row, { type: 'group' }> =>
    row !== undefined && row.type !== 'group';
  const navStep = useCallback(
    (from: number, step: 1 | -1): number => {
      for (let i = from + step; i >= 0 && i < rows.length; i += step) if (isNav(rows[i])) return i;
      return -1;
    },
    [rows],
  );

  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!isNav(row)) return;
      reveal(index);
      setFocusKey(row.key);
      pendingFocus.current = row.key;
      const element = scrollerRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-key="${row.key}"]`);
      if (element !== null && element !== undefined) {
        element.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    },
    [rows, reveal],
  );

  // A row that was asked to take the focus and was not mounted yet takes it once it is.
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === null) return;
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-key="${wanted}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const activate = useCallback(
    (summary: AnnotationSummary) => {
      setFocusKey(`a${summary.id}`);
      // Focus stays where it is: in the tree. The page loads first, so the selection has its annotation.
      useViewer.getState().goToPage(positionOf(docId, summary.pageId) ?? summary.pageId);
      const store = useAnnotations.getState();
      void store
        .loadPage(docId, summary.pageId)
        .catch(() => undefined)
        .then(() => store.select(docId, [summary.id]));
    },
    [docId],
  );
  const toggle = useCallback((root: number) => useComments.getState().toggle(docId, root), [docId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
    const index = Number(item?.dataset.index);
    const row = rows[index];
    if (item === null || !isNav(row)) return;
    const rtl = document.documentElement.dir === 'rtl' || getComputedStyle(item).direction === 'rtl';
    const key =
      event.key === 'ArrowRight'
        ? rtl
          ? 'ArrowLeft'
          : 'ArrowRight'
        : event.key === 'ArrowLeft'
          ? rtl
            ? 'ArrowRight'
            : 'ArrowLeft'
          : event.key;
    const store = useComments.getState();
    let handled = true;
    if (key === 'ArrowDown') {
      const next = navStep(index, 1);
      if (next >= 0) focusRow(next);
    } else if (key === 'ArrowUp') {
      const previous = navStep(index, -1);
      if (previous >= 0) focusRow(previous);
    } else if (key === 'Home') {
      focusRow(navStep(-1, 1));
    } else if (key === 'End') {
      focusRow(navStep(rows.length, -1));
    } else if (key === 'ArrowRight') {
      if (row.type === 'root' && row.expanded === false) store.toggle(docId, row.summary.id);
      else if (row.type === 'root' && row.expanded === true) focusRow(index + 1);
    } else if (key === 'ArrowLeft') {
      if (row.type === 'root' && row.expanded === true) store.toggle(docId, row.summary.id);
      else if (row.type === 'reply') {
        const parent = rowIndexOf.get(`a${row.root}`);
        if (parent !== undefined) focusRow(parent);
      }
    } else if (key === 'Enter' || key === ' ') {
      activate(row.summary);
    } else if (key === 'Delete' || key === 'Backspace') {
      if (row.summary.kind !== 'opaque') {
        const next = navStep(index, 1);
        const fallback = next >= 0 ? next : navStep(index, -1);
        void useAnnotations
          .getState()
          .apply(docId, { type: 'deleteAnnotations', ids: [row.summary.id] })
          .then(() => (fallback >= 0 ? focusRow(Math.min(fallback, index)) : undefined))
          .catch(() => undefined);
      }
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  };

  // The tab stop: the focused row, else the selected one, else the first.
  const tabKey = useMemo(() => {
    for (const key of [focusKey, selectedFirst === undefined ? null : `a${selectedFirst}`]) {
      if (key !== null && rowIndexOf.has(key)) return key;
    }
    const first = rows.find((row) => row.type !== 'group');
    return first?.key ?? null;
  }, [focusKey, selectedFirst, rowIndexOf, rows]);

  const range = windowOf(offsets, scrollTop, box, OVERSCAN_PX);
  const mounted = useMemo(() => {
    const set = new Set<number>();
    if (range !== null) for (let i = range.first; i <= range.last; i += 1) set.add(i);
    for (const key of [tabKey, focusKey]) {
      const i = key === null ? undefined : rowIndexOf.get(key);
      if (i !== undefined) set.add(i);
    }
    return [...set].sort((a, b) => a - b);
  }, [range?.first, range?.last, tabKey, focusKey, rowIndexOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
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
        <p className="m-0 px-1 pb-0-5 text-sm text-text-muted">
          {t('comments.filtered', { shown: threads.length, total })}
        </p>
      )}
      <div
        ref={scrollerRef}
        onScroll={(event) => {
          // Only a change of the mounted window renders the tree again.
          const top = event.currentTarget.scrollTop;
          setScrollTop((previous) => {
            const before = windowOf(offsets, previous, box, OVERSCAN_PX);
            const after = windowOf(offsets, top, box, OVERSCAN_PX);
            return before?.first === after?.first && before?.last === after?.last ? previous : top;
          });
        }}
        className="min-h-0 flex-auto overflow-y-auto overflow-x-hidden p-1 [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <div
          role="tree"
          aria-label={t('comments.list')}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const item =
              event.target instanceof Element ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
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
            return (
              <CommentRow
                key={row.key}
                row={row}
                index={i}
                top={offsets[i] as number}
                height={heights[row.type]}
                selected={row.type !== 'group' && selected.has(row.summary.id)}
                tabStop={tabKey === row.key}
                onActivate={activate}
                onToggle={toggle}
              />
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
  const rev = useAnnotations((state) => state.byDoc[docId]?.rev ?? 0);
  // Live from the change sets: the list is read again once the changes have settled. The first read is at once.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      useComments.getState().load(docId);
      return;
    }
    const timer = window.setTimeout(() => useComments.getState().load(docId), REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [docId, rev]);

  if (entry === undefined || entry.status === 'loading') return <Loading />;
  if (entry.status === 'error') {
    return (
      <Message>
        <div role="alert" className="flex flex-col items-center gap-1">
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
  return <CommentsTree docId={docId} entry={entry} />;
}

/** The Comments tab's content. Another document is another list: its view, scroll and focus are its own. */
export function Comments() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  if (docId === null) return <p className="m-0 text-sm text-text-muted">{t('leftPanel.empty.comments')}</p>;
  return <CommentsView key={docId} docId={docId} />;
}

function FilterGroup<T extends string>({
  legend,
  values,
  chosen,
  label,
  onChange,
}: {
  legend: string;
  values: readonly T[];
  chosen: readonly T[];
  label: (value: T) => string;
  onChange: (next: T[]) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-0-5 border-0 p-0">
      <legend className="p-0 pb-0-5 text-sm font-semibold text-text-muted">{legend}</legend>
      {values.map((value) => (
        <label key={value} className="flex min-h-control-sm cursor-pointer items-center gap-1 text-md">
          <input
            type="checkbox"
            className="accent-accent"
            checked={chosen.includes(value)}
            onChange={(event) =>
              onChange(event.target.checked ? [...chosen, value] : chosen.filter((other) => other !== value))
            }
          />
          <span className="min-w-0 flex-1 truncate">{label(value)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** The Comments tab's title-row actions: the filter popover and the sort menu. */
export function CommentsActions() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const entry = useComments((state) => (docId === null ? undefined : state.byDoc[docId]));
  const view = useComments((state) => (docId === null ? undefined : state.views[docId])) ?? DEFAULT_VIEW;
  const summaries = entry?.status === 'ready' ? entry.summaries : null;
  const options = useMemo(() => (summaries === null ? { kinds: [], authors: [] } : facets(summaries)), [summaries]);
  if (docId === null) return null;
  const can = summaries !== null && summaries.length > 0;
  const filtering = isFiltering(view.filter);
  return (
    <>
      <Popover
        label={t('comments.filter')}
        side="bottom"
        align="end"
        disabled={!can}
        trigger={(trigger) => (
          <IconButton
            {...trigger}
            size="sm"
            icon={ListFilter}
            label={t('comments.filter')}
            tooltipSide="bottom"
            active={filtering}
            disabled={!can}
            focusableWhenDisabled
          />
        )}
      >
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto p-1">
          <FilterGroup
            legend={t('comments.type')}
            values={options.kinds}
            chosen={view.filter.kinds}
            label={(kind) => t(kindLabel(kind))}
            onChange={(kinds) => useComments.getState().setFilter(docId, { ...view.filter, kinds })}
          />
          <FilterGroup
            legend={t('comments.author')}
            values={options.authors}
            chosen={view.filter.authors}
            label={(author) => (author === '' ? t('comments.noAuthor') : author)}
            onChange={(authors) => useComments.getState().setFilter(docId, { ...view.filter, authors })}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!filtering}
            focusableWhenDisabled
            onClick={() => useComments.getState().setFilter(docId, NO_FILTER)}
          >
            {t('comments.reset')}
          </Button>
        </div>
      </Popover>
      <Menu
        label={t('comments.sort')}
        side="bottom"
        align="end"
        disabled={!can}
        entries={SORT_ORDERS.map((order) => ({
          id: order,
          label: t(SORT_LABELS[order]),
          checked: view.order === order,
          onSelect: () => useComments.getState().setOrder(docId, order),
        }))}
        trigger={(trigger) => (
          <IconButton
            {...trigger}
            size="sm"
            icon={ArrowDownUp}
            label={t('comments.sort')}
            tooltipSide="bottom"
            disabled={!can}
            focusableWhenDisabled
          />
        )}
      />
    </>
  );
}
