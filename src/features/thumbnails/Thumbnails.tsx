import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { rovingTarget } from '../../components/roving';
import { tokenPx } from '../../components/tokens';
import type { RenderScheduler } from '../../engine/renderScheduler';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { DEFAULT_PAGE_SIZE, sizesFor, usePages, useSlots } from '../../stores/pages';
import { useDocViewValue, useView } from '../../stores/view';
import { useDevicePixelRatio } from '../viewer/useDevicePixelRatio';
import { useViewer } from '../viewer/useViewer';
import {
  ThumbnailLayout,
  thumbnailMetricsFor,
  type IndexRange,
  type ListAnchor,
  type ThumbnailSpacing,
} from './layout';
import { launchJump } from '../viewer/openTransition';
import { ThumbnailItem } from './ThumbnailItem';

/** The most cells mounted at once, in view or around it: a bound for a list whose thumbnails are tiny. */
export const MAX_MOUNTED_THUMBNAILS = 64;

/** Cells are mounted this far (in viewport heights) above and below the viewport, so a slow scroll does not show blanks. */
const OVERSCAN_VIEWPORTS = 0.5;

/**
 * After the user has scrolled the list (wheel, touch, scrollbar), a change of the canvas's page does not move it for this long:
 * the list follows the canvas, but it never takes the scroll position from someone who is using it.
 */
export const USER_SCROLL_GRACE_MS = 1500;

const SPACING_FALLBACK = { pad: 4, labelGap: 4, labelHeight: 16, gap: 4 } as const;

/** The fixed parts of a cell in px, read from the spacing tokens once (`--space-0-5`: 4 px, `--space-2`: 16 px). */
function readSpacing(): ThumbnailSpacing {
  const small = tokenPx('--space-0-5', SPACING_FALLBACK.pad);
  return { pad: small, labelGap: small, labelHeight: tokenPx('--space-2', SPACING_FALLBACK.labelHeight), gap: small };
}

interface Box {
  /** The width of the scroll region's content box and the height of the whole region, in px. */
  width: number;
  height: number;
}

const UNMEASURED: Box = { width: 0, height: 0 };

function sameRange(a: IndexRange | null, b: IndexRange | null): boolean {
  return a === b || (a !== null && b !== null && a.first === b.first && a.last === b.last);
}

/**
 * `found` (the cells in view and the overscan around them) cut to at most `MAX_MOUNTED_THUMBNAILS`: the overscan goes first, and
 * the cells that are in view (`visible`) are never cut, even if there are more of them than the cap.
 */
export function capRange(found: IndexRange | null, visible: IndexRange | null): IndexRange | null {
  if (found === null || found.last - found.first + 1 <= MAX_MOUNTED_THUMBNAILS) return found;
  if (visible === null) return { first: found.first, last: found.first + MAX_MOUNTED_THUMBNAILS - 1 };
  const spare = Math.max(0, MAX_MOUNTED_THUMBNAILS - (visible.last - visible.first + 1));
  const after = Math.min(found.last - visible.last, Math.ceil(spare / 2));
  const before = Math.min(visible.first - found.first, spare - after);
  const more = Math.min(found.last - visible.last - after, spare - after - before);
  return { first: visible.first - before, last: visible.last + after + more };
}

/** The option an event came from, and its page. */
function optionOf(target: EventTarget): { element: HTMLElement; index: number } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('[role="option"]');
  const index = Number(element?.dataset.index);
  return element !== null && Number.isInteger(index) ? { element, index } : null;
}

export interface ThumbnailListProps {
  docId: number;
  pageCount: number;
  /** The scheduler and its cache; the app's by default. */
  scheduler?: RenderScheduler;
}

/**
 * The thumbnails of an open document (DESIGN 3.9): a virtualized `listbox` of one `option` per page. Every page has a
 * placeholder of its shape, as wide as the panel lets it be, so the list is as long as it will be before any image is there;
 * only the cells near the viewport are mounted, and they ask for their images lazily (`ThumbnailItem`).
 *
 * - **Current page.** The option of the canvas's page is selected (a fill and a ring, `aria-selected`). The list follows the canvas:
 *   when its page changes the option scrolls into view if it is not whole in view already, unless the user scrolled the list
 *   themselves a moment ago (`USER_SCROLL_GRACE_MS`). Each cell subscribes to whether it is the current page, so a page change
 *   renders two cells, not the list, and a scroll of the canvas renders nothing here.
 * - **Keys.** One tab stop (roving): the current page until the user has moved, then the cell they moved to. Up and Down move one
 *   cell, Home and End the ends, PageUp and PageDown about a screenful; focus moves, the canvas does not. Enter and Space go to the
 *   page; so does a click. Alt with Up or Down is reserved for moving a thumbnail (M3) and does nothing yet; Ctrl or Cmd with them
 *   is the next and previous page of the actions registry and is left alone.
 * - **Virtualization and focus.** The tab stop is always mounted (the current page when focus is elsewhere, the focused cell when
 *   it is in the list), so Tab always finds the list and a scrolled-away cell keeps its focus.
 * - **Width.** A change of the panel's width keeps the cell at the top of the viewport where it is.
 */
export function ThumbnailList({ docId, pageCount, scheduler }: ThumbnailListProps) {
  const t = useT();
  const sizes = usePages((state) => sizesFor(state, docId, pageCount));
  // Cell i shows the page with id slots[i].id (ADR-036).
  const slots = useSlots(docId);
  const pixelRatio = useDevicePixelRatio();
  const [spacing] = useState(readSpacing);
  // The scroll region's padding: room for the focus ring of a cell at its edge (outline 2 px + offset 2 px).
  const inset = spacing.pad;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(UNMEASURED);
  const [range, setRange] = useState<IndexRange | null>(null);
  // The range that was last set: a scroll that changes nothing must not even ask React to render the list again.
  const rangeSet = useRef<IndexRange | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const measured = box.width > 0 && box.height > 0;

  const layout = useMemo(
    () => new ThumbnailLayout(thumbnailMetricsFor(sizes), box.width - 2 * spacing.pad - 2 * inset, spacing),
    [sizes, box.width, spacing, inset],
  );

  // Where the user last scrolled the list, the scroll position that the list itself last set (a scroll event at any other
  // position is the user's), and the place at the top of the viewport (what a change of width keeps).
  const userScrolledAt = useRef(Number.NEGATIVE_INFINITY);
  const programmaticTop = useRef(0);
  const anchor = useRef<ListAnchor | null>(null);
  const previousLayout = useRef<ThumbnailLayout | null>(null);
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    const region = scrollerRef.current;
    if (region === null) return;
    const observer = new ResizeObserver(() => {
      const width = Math.max(0, region.clientWidth);
      const height = region.clientHeight;
      setBox((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  /** Moves the list to `top` (px of the scroll region) and remembers that it was this component that did. */
  const scrollTo = useCallback((top: number) => {
    const region = scrollerRef.current;
    if (region === null) return;
    region.scrollTop = top;
    programmaticTop.current = region.scrollTop;
  }, []);

  /** Mounts the cells near the viewport and notes the place at its top. */
  const track = useCallback(() => {
    const region = scrollerRef.current;
    if (region === null || !measured || layout.count === 0) return;
    const viewTop = region.scrollTop - inset;
    const viewHeight = region.clientHeight;
    const reach = viewHeight * OVERSCAN_VIEWPORTS;
    const visible = layout.itemsIn(viewTop, viewTop + viewHeight);
    const found = layout.itemsIn(viewTop - reach, viewTop + viewHeight + reach);
    const next = capRange(found, visible);
    if (!sameRange(rangeSet.current, next)) {
      rangeSet.current = next;
      setRange(next);
    }
    anchor.current = layout.anchorAt(viewTop);
  }, [layout, measured, inset]);

  /** Scrolls the list so that the cell of `index` shows (see `ThumbnailLayout.reveal`). */
  const reveal = useCallback(
    (index: number) => {
      const region = scrollerRef.current;
      if (region === null) return;
      const target = layout.reveal(index, region.scrollTop - inset, region.clientHeight, inset);
      if (target !== null) scrollTo(target + inset);
    },
    [layout, inset, scrollTo],
  );

  // A new layout (first measured, a change of the panel's width, the page sizes that arrived): the first one shows the current
  // page; a later one keeps the place at the top of the viewport.
  useLayoutEffect(() => {
    const region = scrollerRef.current;
    if (region === null || !measured) return;
    const before = previousLayout.current;
    previousLayout.current = layout;
    if (before === null) {
      reveal(useView.getState().byDoc[docId]?.pageIndex ?? 0);
    } else if (before !== layout && anchor.current !== null) {
      scrollTo(layout.positionOf(anchor.current) + inset);
    }
    track();
  }, [layout, measured, docId, inset, reveal, scrollTo, track]);

  // The list follows the canvas's page, unless the user is scrolling the list.
  useEffect(
    () =>
      useView.subscribe((state, previous) => {
        const page = state.byDoc[docId]?.pageIndex;
        if (page === undefined || page === previous.byDoc[docId]?.pageIndex) return;
        if (performance.now() - userScrolledAt.current < USER_SCROLL_GRACE_MS) return;
        reveal(page);
        track();
      }),
    [docId, reveal, track],
  );

  // The tab stop is mounted wherever it is: the current page, unless that is in the mounted range already.
  const current = useView((state) => {
    const page = state.byDoc[docId]?.pageIndex ?? 0;
    return range !== null && page >= range.first && page <= range.last ? -1 : page;
  });
  const mounted = useMemo(() => {
    if (!measured || range === null) return [];
    const set = new Set<number>();
    for (let index = range.first; index <= range.last; index += 1) set.add(index);
    if (current >= 0 && current < layout.count) set.add(current);
    if (focusIndex !== null && focusIndex < layout.count) set.add(focusIndex);
    return [...set].sort((a, b) => a - b);
  }, [measured, range, current, focusIndex, layout.count]);

  const focusOption = useCallback((index: number): boolean => {
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[role="option"][data-index="${index}"]`);
    if (element === null || element === undefined) return false;
    // The list has scrolled to it already; the browser's own scrolling would only second-guess it.
    element.focus({ preventScroll: true });
    return true;
  }, []);

  // A cell that was asked to take the focus and was not mounted yet takes it once it is.
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted !== null && focusOption(wanted)) pendingFocus.current = null;
  });

  const moveFocus = (index: number) => {
    // The user is working in the list: the canvas does not take its scroll position for a moment.
    userScrolledAt.current = performance.now();
    reveal(index);
    setFocusIndex(index);
    pendingFocus.current = index;
    if (focusOption(index)) pendingFocus.current = null;
    track();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const from = optionOf(event.target);
    if (from === null || event.defaultPrevented) return;
    if (event.altKey) {
      // Alt+Up and Alt+Down are "move thumbnail up/down" (M3): reserved, nothing happens yet.
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      useViewer.getState().goToPage(from.index);
      return;
    }
    const height = scrollerRef.current?.clientHeight ?? 0;
    let target: number | null;
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      const next = layout.pageTarget(from.index, event.key === 'PageDown' ? 1 : -1, height);
      target = next === from.index ? null : next;
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      target = rovingTarget(event.key, from.index, layout.count, { orientation: 'vertical', wrap: false });
    } else {
      return;
    }
    // Scrolling is the list's own business here, also at the ends where nothing moves.
    event.preventDefault();
    if (target !== null) moveFocus(target);
  };

  // A click: the thumbnail's picture is cloned and flies into its page once the jump has scrolled there (MOTION 4.6).
  const activate = useCallback(
    (index: number) => {
      const image = scrollerRef.current?.querySelector<HTMLImageElement>(`[role="option"][data-index="${index}"] img`);
      if (image !== null && image !== undefined && image.src !== '') {
        const box = image.getBoundingClientRect();
        launchJump(docId, index, {
          kind: 'image',
          src: image.src,
          rect: { left: box.left, top: box.top, width: box.width, height: box.height },
        });
      }
      useViewer.getState().goToPage(index);
    },
    [docId],
  );

  return (
    <div
      ref={scrollerRef}
      onScroll={() => {
        const region = scrollerRef.current;
        if (region !== null && Math.abs(region.scrollTop - programmaticTop.current) > 0.5) {
          userScrolledAt.current = performance.now();
        }
        track();
      }}
      className="min-h-0 flex-auto overflow-y-auto overflow-x-hidden p-0-5 [overflow-anchor:none] [scrollbar-gutter:stable]"
    >
      <div
        role="listbox"
        aria-label={t('thumbnails.list')}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const option = optionOf(event.target);
          if (option !== null) setFocusIndex(option.index);
        }}
        onBlur={(event) => {
          // Focus that moves from one cell to another stays in the list; leaving it hands the tab stop back to the current page.
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
            setFocusIndex(null);
          }
        }}
        className="relative"
        style={{ height: layout.height + inset }}
      >
        {mounted.map((index) => {
          const size = layout.thumbnailSize(index);
          return (
            <ThumbnailItem
              key={index}
              docId={docId}
              index={index}
              pageId={slots[index]?.id ?? index}
              pageRev={slots[index]?.rev ?? 0}
              pageCount={pageCount}
              top={layout.top(index)}
              height={layout.cellHeight(index)}
              thumbWidth={size.width}
              thumbHeight={size.height}
              widthPt={(sizes[index] ?? DEFAULT_PAGE_SIZE)[0]}
              pixelRatio={pixelRatio}
              active={range !== null && index >= range.first && index <= range.last}
              focusStop={focusIndex === null ? null : focusIndex === index}
              onActivate={activate}
              scheduler={scheduler}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The thumbnails tab's content: the open document's list, or what will appear there while there is no document. It follows the
 * active document and its page count, and nothing else (the list follows the rest itself).
 */
export function Thumbnails() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const pageCount = useDocViewValue(docId, (view) => view.pageCount);
  if (docId === null || pageCount === 0)
    return <p className="m-0 text-sm text-text-muted">{t('leftPanel.empty.thumbnails')}</p>;
  // Another document is another list: its scroll position, focus and cells are its own.
  return <ThumbnailList key={docId} docId={docId} pageCount={pageCount} />;
}
