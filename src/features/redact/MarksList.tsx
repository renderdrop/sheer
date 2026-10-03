import { Square, Text, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { IconButton } from '../../components';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { tokenPx } from '../../components/tokens';
import { useT } from '../../i18n';
import { pageNumberOf } from '../../stores/pages';
import { buildRows, rowRange } from '../search/rows';
import { loadLayer } from '../textlayer/cache';
import { goToMark, removeMarks } from './actions';
import { excerptOf } from './excerpt';
import { useRedact, type RedactMark } from './store';

/** Rows mounted beyond the viewport on each side. */
export const OVERSCAN_ROWS = 6;
const PAGE_ROW_FALLBACK = 24;
const MARK_ROW_FALLBACK = 48;

/** The text of a text mark, once its page's text layer is there; `null` before, or when there is none. */
function useExcerpt(docId: number, mark: RedactMark): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (mark.source !== 'text') return;
    let live = true;
    void loadLayer(docId, mark.pageId).then((layer) => {
      if (!live || layer === null) return;
      const excerpt = excerptOf(layer, mark);
      setText(excerpt === '' ? null : excerpt);
    });
    return () => {
      live = false;
    };
  }, [docId, mark]);
  return text;
}

interface RowProps {
  docId: number;
  mark: RedactMark;
  index: number;
  row: number;
  top: number;
  selected: boolean;
  tabStop: boolean;
}

/** One mark: its kind icon and excerpt (or "Area"), and a remove button that shows on hover and focus. */
const MarkRow = memo(function MarkRow({ docId, mark, index, row, top, selected, tabStop }: RowProps) {
  const t = useT();
  const excerpt = useExcerpt(docId, mark);
  const text = mark.source === 'area' ? t('redact.area') : (excerpt ?? t('redact.mark'));
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${t('search.page', { n: pageNumberOf(docId, mark.pageId) })}, ${text}`}
      data-mark={index}
      data-row={row}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => goToMark(docId, mark)}
      className={cx(
        'group absolute inset-x-0 box-border flex h-search-row cursor-pointer select-none items-center gap-1 rounded-sm p-1 text-sm',
        selected
          ? 'bg-selected forced-colors:outline-2 forced-colors:outline-[Highlight]'
          : 'hover:bg-control-hover active:bg-control-pressed',
      )}
      style={{ top }}
    >
      <span className="shrink-0 text-text-muted">
        <Icon icon={mark.source === 'area' ? Square : Text} />
      </span>
      <span className="line-clamp-2 min-w-0 flex-auto break-words">{text}</span>
      <span className="shrink-0 opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 forced-colors:opacity-100">
        <IconButton
          size="sm"
          icon={X}
          label={t('redact.remove')}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            void removeMarks(docId, [mark.id]);
          }}
        />
      </span>
    </div>
  );
});

/**
 * The marks to review (DESIGN 3.38): a listbox grouped by page, virtualized by arithmetic (fixed row heights, as the search hits),
 * roving focus. Enter or a click goes to the mark and selects it; Delete removes it.
 */
export function MarksList({ docId, marks }: { docId: number; marks: readonly RedactMark[] }) {
  const t = useT();
  const selectedId = useRedact((state) => state.selected[docId] ?? null);
  const [pageHeight] = useState(() => tokenPx('--control-sm', PAGE_ROW_FALLBACK));
  const [markHeight] = useState(() => tokenPx('--search-row-height', MARK_ROW_FALLBACK));
  const layout = useMemo(
    () =>
      buildRows(
        marks.map((mark, index) => ({ index, page: mark.pageId, quads: mark.quads })),
        pageHeight,
        markHeight,
      ),
    [marks, pageHeight, markHeight],
  );
  const scroller = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focused, setFocused] = useState(-1);
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    const region = scroller.current;
    if (region === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBox(region.clientHeight));
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = marks.findIndex((mark) => mark.id === selectedId);
  const range = rowRange(layout.tops, scrollTop, box, OVERSCAN_ROWS);

  // The selected mark is brought into view when it changes (a click on the page, a key); the user's own scrolling is left alone.
  useLayoutEffect(() => {
    const region = scroller.current;
    const row = selectedIndex >= 0 ? (layout.rowOfHit[selectedIndex] ?? -1) : -1;
    if (region === null || row < 0 || box === 0) return;
    const top = layout.tops[row] ?? 0;
    const bottom = layout.tops[row + 1] ?? top;
    if (top < region.scrollTop) region.scrollTop = top;
    else if (bottom > region.scrollTop + region.clientHeight) region.scrollTop = bottom - region.clientHeight;
    setScrollTop(region.scrollTop);
  }, [selectedIndex, layout, box]);

  const tabIndex = focused >= 0 && focused < marks.length ? focused : selectedIndex >= 0 ? selectedIndex : 0;

  const focusMark = (index: number) => {
    const row = layout.rowOfHit[index];
    const region = scroller.current;
    if (row === undefined || region === null) return;
    pendingFocus.current = index;
    setFocused(index);
    const top = layout.tops[row] ?? 0;
    const bottom = layout.tops[row + 1] ?? top;
    if (top < region.scrollTop) region.scrollTop = top;
    else if (bottom > region.scrollTop + region.clientHeight) region.scrollTop = bottom - region.clientHeight;
    setScrollTop(region.scrollTop);
  };
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === null) return;
    const element = scroller.current?.querySelector<HTMLElement>(`[data-mark="${wanted}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null;
    const index = Number(item?.dataset.mark);
    const mark = marks[index];
    if (item === null || mark === undefined) return;
    const last = marks.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusMark(Math.min(last, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusMark(Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        focusMark(0);
        break;
      case 'End':
        event.preventDefault();
        focusMark(last);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        goToMark(docId, mark);
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        // Focus stays in the list, on the neighbour that takes the place.
        focusMark(Math.min(index, last - 1));
        void removeMarks(docId, [mark.id]);
        break;
      default:
    }
  };

  const mounted = useMemo(() => {
    const set = new Set<number>();
    if (range !== null) for (let row = range.first; row <= range.last; row += 1) set.add(row);
    const tabRow = layout.rowOfHit[tabIndex];
    if (tabRow !== undefined && marks.length > 0) set.add(tabRow);
    return [...set].sort((a, b) => a - b);
  }, [range?.first, range?.last, layout, tabIndex, marks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={scroller}
      data-redact-list=""
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setScrollTop((previous) => {
          const before = rowRange(layout.tops, previous, box, OVERSCAN_ROWS);
          const after = rowRange(layout.tops, top, box, OVERSCAN_ROWS);
          return before?.first === after?.first && before?.last === after?.last ? previous : top;
        });
      }}
      className="max-h-[50vh] min-h-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none] [scrollbar-gutter:stable]"
    >
      <div
        role="listbox"
        aria-label={t('redact.title', { count: marks.length })}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
            setFocused(-1);
        }}
        className="relative"
        style={{ height: layout.tops[layout.tops.length - 1] ?? 0 }}
      >
        {mounted.map((row) => {
          const item = layout.rows[row];
          if (item === undefined) return null;
          const top = layout.tops[row] ?? 0;
          if (item.kind === 'page') {
            return (
              <div
                key={`p${item.page}`}
                role="presentation"
                className="absolute inset-x-0 flex h-control-sm items-center px-1 text-sm font-semibold text-text-muted"
                style={{ top }}
              >
                {t('search.page', { n: pageNumberOf(docId, item.page) })}
              </div>
            );
          }
          const mark = marks[item.hit];
          if (mark === undefined) return null;
          return (
            <MarkRow
              key={mark.id}
              docId={docId}
              mark={mark}
              index={item.hit}
              row={row}
              top={top}
              selected={selectedId === mark.id}
              tabStop={tabIndex === item.hit}
            />
          );
        })}
      </div>
    </div>
  );
}
