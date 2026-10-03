import { ChevronRight, ChevronsDownUp, CircleAlert, ListTree, LoaderCircle } from 'lucide-react';
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

import { Button, IconButton, Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { tokenPx } from '../../components/tokens';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { subscribeViewRect } from '../viewer/scrollBridge';
import { useViewer } from '../viewer/useViewer';
import { readingPosition } from './reading';
import { useOutline, type OutlineEntry } from './store';
import {
  TYPE_AHEAD_MS,
  currentNode,
  hasParents,
  rowsOf,
  treeKey,
  typeAheadRow,
  visibleAncestor,
  visibleRows,
  windowRange,
} from './tree';

/** The current-section marker is recomputed this long after the scrolling has settled (DESIGN 3.15). */
export const CURRENT_SETTLE_MS = 150;
/** The loading state shows nothing for this long. */
export const LOADING_SHOWN_AFTER_MS = 300;
/** Rows mounted beyond the viewport on each side. */
export const OVERSCAN_ROWS = 8;

const ROW_HEIGHT_FALLBACK = 32;

type Ready = Extract<OutlineEntry, { status: 'ready' }>;

interface RowProps {
  node: number;
  row: number;
  title: string;
  level: number;
  posinset: number;
  setsize: number;
  /** `undefined` for a leaf. */
  expanded: boolean | undefined;
  hasTarget: boolean;
  selected: boolean;
  current: boolean;
  tabStop: boolean;
  top: number;
  onActivate: (node: number) => void;
  onToggle: (node: number) => void;
}

/** One treeitem. The title is a text node: it comes from the file. */
const OutlineRow = memo(function OutlineRow({
  node,
  row,
  title,
  level,
  posinset,
  setsize,
  expanded,
  hasTarget,
  selected,
  current,
  tabStop,
  top,
  onActivate,
  onToggle,
}: RowProps) {
  const t = useT();
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const measure = () => {
    const element = titleRef.current;
    setTruncated(element !== null && element.scrollWidth > element.clientWidth);
  };
  const untitled = title === '';
  const muted = untitled || !hasTarget;
  const leaf = expanded === undefined;
  return (
    <Tooltip label={title} side="right" disabled={!truncated}>
      <div
        role="treeitem"
        aria-level={level}
        aria-setsize={setsize}
        aria-posinset={posinset}
        aria-expanded={expanded}
        aria-selected={selected}
        aria-current={current ? 'location' : undefined}
        aria-disabled={leaf && !hasTarget ? true : undefined}
        aria-description={hasTarget ? undefined : t('outline.noTarget')}
        data-node={node}
        data-row={row}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => onActivate(node)}
        onPointerEnter={measure}
        onFocus={measure}
        className={cx(
          'absolute inset-x-0 flex h-control-md cursor-pointer select-none items-center gap-0-5 rounded-sm pe-1 text-md',
          selected
            ? 'bg-selected forced-colors:outline-2 forced-colors:outline-[Highlight]'
            : 'hover:bg-control-hover active:bg-control-pressed',
          muted ? 'text-text-muted forced-colors:text-[GrayText]' : 'text-text',
        )}
        style={{
          top,
          paddingInlineStart: `calc(var(--space-0-5) + min(var(--outline-indent) * ${level - 1}, var(--outline-indent-max)))`,
        }}
      >
        {current && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute start-[calc(var(--space-0-5)/2)] top-1/2 h-icon-16 w-0 -translate-y-1/2 rounded-pill border-s-2 border-accent forced-colors:border-[Highlight]"
          />
        )}
        <span
          aria-hidden="true"
          onClick={
            leaf
              ? undefined
              : (event: MouseEvent) => {
                  // The chevron toggles without jumping.
                  event.stopPropagation();
                  onToggle(node);
                }
          }
          className="flex size-control-sm shrink-0 items-center justify-center"
        >
          {!leaf && (
            <Icon
              icon={ChevronRight}
              className={cx(
                'transition-transform duration-fast motion-reduce:transition-none forced-colors:text-[CanvasText]',
                expanded ? 'rotate-90' : 'rtl:-scale-x-100',
              )}
            />
          )}
        </span>
        <span ref={titleRef} className="min-w-0 flex-1 truncate">
          {untitled ? t('outline.untitled') : title}
        </span>
      </div>
    </Tooltip>
  );
});

/** The tree of a loaded outline: virtualized, one tab stop, the WAI-ARIA keyboard model. */
export function OutlineTree({ docId, entry }: { docId: number; entry: Ready }) {
  const t = useT();
  const { index, expanded, selected } = entry;
  const rows = useMemo(() => visibleRows(index, expanded), [index, expanded]);
  const rowOf = useMemo(() => rowsOf(index, rows), [index, rows]);
  const [rowHeight] = useState(() => tokenPx('--control-md', ROW_HEIGHT_FALLBACK));
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusNode, setFocusNode] = useState<number | null>(null);
  const [current, setCurrent] = useState(-1);
  const pendingFocus = useRef<number | null>(null);
  const typed = useRef({ text: '', timer: 0 });

  useEffect(() => {
    const region = scrollerRef.current;
    if (region === null) return;
    const observer = new ResizeObserver(() => setBox(region.clientHeight));
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  // The current section: once on show, then 150 ms after the scrolling settles. The tree never expands or scrolls by itself.
  useEffect(() => {
    const update = () => setCurrent(currentNode(index, readingPosition(docId)));
    update();
    let timer = 0;
    const stop = subscribeViewRect(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, CURRENT_SETTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [docId, index]);

  const markerNode = current < 0 ? -1 : visibleAncestor(index, rowOf, current);

  /** Scrolls the region so that `row` is whole in view (nearest). */
  const reveal = useCallback(
    (row: number) => {
      const region = scrollerRef.current;
      if (region === null) return;
      const top = row * rowHeight;
      if (top < region.scrollTop) region.scrollTop = top;
      else if (top + rowHeight > region.scrollTop + region.clientHeight)
        region.scrollTop = top + rowHeight - region.clientHeight;
      setScrollTop(region.scrollTop);
    },
    [rowHeight],
  );

  // On first show the current row is brought into view, at once.
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (shown.current || box === 0) return;
    shown.current = true;
    const node = current < 0 ? -1 : visibleAncestor(index, rowOf, current);
    if (node >= 0) reveal(rowOf[node] as number);
  }, [box, current, index, rowOf, reveal]);

  const focusRow = useCallback(
    (row: number) => {
      const node = rows[row];
      if (node === undefined) return;
      reveal(row);
      setFocusNode(node);
      pendingFocus.current = node;
      const element = scrollerRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-node="${node}"]`);
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
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-node="${wanted}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const activate = useCallback(
    (node: number) => {
      const state = useOutline.getState();
      const target = index.targets[node] ?? null;
      setFocusNode(node);
      if (target !== null) {
        state.select(docId, node);
        // Targets are positions here (`retarget`: the page ids of the file mapped to where the pages sit now). Focus stays where it is: in the tree.
        useViewer.getState().goToPoint(target.pageId, target.y);
      } else if ((index.childCount[node] ?? 0) > 0) {
        state.toggle(docId, node);
      }
    },
    [docId, index],
  );
  const toggle = useCallback((node: number) => useOutline.getState().toggle(docId, node), [docId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
    const row = Number(item?.dataset.row);
    if (item === null || !Number.isInteger(row)) return;
    const store = useOutline.getState();
    const rtl = document.documentElement.dir === 'rtl' || getComputedStyle(item).direction === 'rtl';
    const action = treeKey(event.key, index, rows, rowOf, expanded, row, rtl);
    if (action !== null) {
      event.preventDefault();
      if (action.type === 'focus') focusRow(action.row);
      else if (action.type === 'expand' || action.type === 'collapse') store.toggle(docId, action.node);
      else if (action.type === 'expandSiblings') store.expandSiblingsOf(docId, action.node);
      else activate(action.node);
      return;
    }
    // Type-ahead: printable keys build a buffer that lives 500 ms.
    if (event.key.length === 1 && event.key !== ' ') {
      window.clearTimeout(typed.current.timer);
      typed.current.text += event.key;
      typed.current.timer = window.setTimeout(() => {
        typed.current.text = '';
      }, TYPE_AHEAD_MS);
      const found = typeAheadRow(index, rows, row, typed.current.text);
      event.preventDefault();
      if (found >= 0) focusRow(found);
    }
  };

  // The tab stop: the focused row, else the selected one, else the current one, else the first; a hidden node stands for the
  // nearest visible ancestor.
  const tabNode = useMemo(() => {
    for (const candidate of [focusNode ?? -1, selected, markerNode]) {
      const node = candidate >= 0 ? visibleAncestor(index, rowOf, candidate) : -1;
      if (node >= 0) return node;
    }
    return rows[0] ?? -1;
  }, [focusNode, selected, markerNode, index, rowOf, rows]);

  const range = windowRange(scrollTop, box, rows.length, rowHeight, OVERSCAN_ROWS);
  const mountedRows = useMemo(() => {
    const set = new Set<number>();
    if (range !== null) for (let row = range.first; row <= range.last; row += 1) set.add(row);
    for (const node of [tabNode, focusNode ?? -1]) {
      const row = node >= 0 ? (rowOf[node] ?? -1) : -1;
      if (row >= 0) set.add(row);
    }
    return [...set].sort((a, b) => a - b);
  }, [range?.first, range?.last, tabNode, focusNode, rowOf]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        // Only a change of the mounted window renders the tree again.
        const top = event.currentTarget.scrollTop;
        setScrollTop((previous) => {
          const before = windowRange(previous, box, rows.length, rowHeight, OVERSCAN_ROWS);
          const after = windowRange(top, box, rows.length, rowHeight, OVERSCAN_ROWS);
          return before?.first === after?.first && before?.last === after?.last ? previous : top;
        });
      }}
      className="min-h-0 flex-auto overflow-y-auto overflow-x-hidden p-1 [overflow-anchor:none] [scrollbar-gutter:stable]"
    >
      <div
        role="tree"
        aria-label={t('outline.list')}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
          const node = Number(item?.dataset.node);
          if (item !== null && Number.isInteger(node)) setFocusNode(node);
        }}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
            setFocusNode(null);
        }}
        className="relative"
        style={{ height: rows.length * rowHeight }}
      >
        {mountedRows.map((row) => {
          const node = rows[row] as number;
          const parent = (index.childCount[node] ?? 0) > 0;
          return (
            <OutlineRow
              key={node}
              node={node}
              row={row}
              title={index.titles[node] as string}
              level={index.level[node] as number}
              posinset={index.posinset[node] as number}
              setsize={index.setsize[node] as number}
              expanded={parent ? expanded.has(node) : undefined}
              hasTarget={index.targets[node] !== null}
              selected={selected === node}
              current={markerNode === node}
              tabStop={tabNode === node}
              top={row * rowHeight}
              onActivate={activate}
              onToggle={toggle}
            />
          );
        })}
      </div>
    </div>
  );
}

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
          <span className="text-sm text-text-muted">{t('outline.loading')}</span>
        </Message>
      )}
    </div>
  );
}

function OutlineView({ docId }: { docId: number }) {
  const t = useT();
  const entry = useOutline((state) => state.byDoc[docId]);
  useEffect(() => {
    useOutline.getState().load(docId);
  }, [docId]);
  if (entry === undefined || entry.status === 'loading') return <Loading />;
  if (entry.status === 'error') {
    return (
      <Message>
        <div role="alert" className="flex flex-col items-center gap-1">
          <Icon icon={CircleAlert} className="text-error-text" />
          <span className="text-md">{t('outline.error')}</span>
        </div>
        <Button size="sm" onClick={() => useOutline.getState().retry(docId)}>
          {t('outline.retry')}
        </Button>
      </Message>
    );
  }
  if (entry.index.count === 0) {
    return (
      <Message>
        <span className="flex size-control-md items-center justify-center rounded-sm bg-tile text-tile-icon">
          <Icon icon={ListTree} />
        </span>
        <span className="text-md font-semibold">{t('outline.empty')}</span>
        <span className="text-sm text-text-muted">{t('outline.emptyHint')}</span>
      </Message>
    );
  }
  return <OutlineTree docId={docId} entry={entry} />;
}

/** The Outline tab's content. Another document is another tree: its scroll, focus and rows are its own. */
export function Outline() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  if (docId === null) return <p className="m-0 text-sm text-text-muted">{t('leftPanel.empty.outline')}</p>;
  return <OutlineView key={docId} docId={docId} />;
}

/** The Outline tab's title-row action: collapse every branch. */
export function OutlineActions() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const can = useOutline((state) => {
    const entry = docId === null ? undefined : state.byDoc[docId];
    return entry?.status === 'ready' && entry.expanded.size > 0 && hasParents(entry.index);
  });
  if (docId === null) return null;
  return (
    <IconButton
      size="sm"
      icon={ChevronsDownUp}
      label={t('outline.collapseAll')}
      tooltipSide="right"
      disabled={!can}
      focusableWhenDisabled
      onClick={() => useOutline.getState().collapseAll(docId)}
    />
  );
}
