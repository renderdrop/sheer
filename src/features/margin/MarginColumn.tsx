import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { PageSize } from '../../api/render';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { pageNumberOf, positionOf } from '../../stores/pages';
import { jumpToAnnotation } from '../viewer/jump';
import type { Thread } from '../comments/model';
import { useCommentHover } from '../comments/useCommentsData';
import { readViewRect, subscribeViewRect } from '../viewer/scrollBridge';
import type { PageLayout } from '../viewer/layout';
import type { Rotation } from '../viewer/transform';
import { Bubble, Marker, type BubbleProps } from './Bubble';
import { CitationBubble } from './CitationBubble';
import { onCitationFocus, useCitations } from '../citations/store';
import { newRestackState, restack } from './restack';
import {
  anchorOf,
  clampColumnX,
  columnX,
  marginMetrics,
  placeBubbles,
  visibleBubbles,
  type MarginMode,
} from './layout';

/** A bubble before it is measured. */
const ESTIMATE_PX = 120;
const CLOCK_MS = 60_000;

/** A thread's bubble: a citation has its own (DESIGN 3.7 C3), everything else is a comment bubble. */
function Shown(props: BubbleProps) {
  return props.thread.root.cite === undefined ? <Bubble {...props} /> : <CitationBubble {...props} />;
}

export interface MarginColumnProps {
  docId: number;
  layout: PageLayout;
  threads: readonly Thread[];
  mode: Exclude<MarginMode, 'off'>;
  /** The pages as drawn (unrotated) and the rotation of the view. */
  drawnSizes: readonly PageSize[];
  rotation: Rotation;
}

interface Item {
  thread: Thread;
  id: number;
  anchor: number;
  right: number;
  /** Where its column starts: 16 px right of its own page (a narrower page has its bubbles closer to it). */
  x: number;
}

/**
 * The comment margin (DESIGN 3.5 B9): a column right of the page stack inside the canvas content. Each bubble sits at the top of
 * its anchor and stacks 8 px below the one above; the selected or focused one keeps its anchor and the others restack around it.
 * Only the bubbles near the viewport are mounted (the heights of the others are estimates). In the compact column every bubble is
 * a 24 px avatar marker that opens the bubble as a popover to its left.
 */
export function MarginColumn({ docId, layout, threads, mode, drawnSizes, rotation }: MarginColumnProps) {
  const t = useT();
  const citations = useCitations(docId);
  const metrics = marginMetrics();
  // Only the anchors of the shown roots (a shallow list), not the whole annotation map.
  const rects = useAnnotations(
    useShallow((state) => {
      const byId = state.byDoc[docId]?.byId;
      return threads.map((thread) => byId?.[thread.root.id]?.rect ?? null);
    }),
  );
  const selectedFirst = useAnnotations((state) => state.selectedIds[docId]?.[0]);
  const view = useSyncExternalStore(subscribeViewRect, readViewRect);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // The geometry of a comment is in its page: the pages that have bubbles are read (what the list's cards do for theirs).
  useEffect(() => {
    const pages = new Set(threads.map((thread) => thread.root.pageId));
    for (const pageId of pages) {
      void useAnnotations
        .getState()
        .loadPage(docId, pageId)
        .catch(() => undefined);
    }
  }, [docId, threads]);

  const items = useMemo<Item[]>(() => {
    const placed: Item[] = [];
    for (const [index, thread] of threads.entries()) {
      const position = positionOf(docId, thread.root.pageId);
      const box = position === null ? null : layout.box(position);
      if (position === null || box === null) continue;
      const rect = rects[index] ?? null;
      const anchor = anchorOf(box, layout.scale, rect, drawnSizes[position] ?? [0, 0], rotation);
      placed.push({
        thread,
        id: thread.root.id,
        anchor: anchor.top,
        right: anchor.right,
        x: columnX(box, metrics.gap),
      });
    }
    return placed.sort((a, b) => a.anchor - b.anchor || a.id - b.id);
  }, [threads, layout, rects, drawnSizes, rotation, docId, metrics.gap]);

  // Measured heights, one observer for the mounted bubbles.
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    observer.current ??= new ResizeObserver((entries) => {
      setHeights((before) => {
        let next: Map<number, number> | null = null;
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.item);
          const height = entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
          if (height > 0 && before.get(id) !== height) {
            next ??= new Map(before);
            next.set(id, height);
          }
        }
        return next ?? before;
      });
    });
    observer.current.observe(element);
  }, []);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  const [focusId, setFocusId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  // A deleted comment takes its measured height and any focus or open state with it; nothing stale pins or places the others.
  const liveIds = new Set(items.map((item) => item.id));
  for (const id of heights.keys()) {
    if (liveIds.has(id)) continue;
    setHeights(new Map([...heights].filter(([key]) => liveIds.has(key))));
    break;
  }
  if (focusId !== null && !liveIds.has(focusId)) setFocusId(null);
  if (openId !== null && !liveIds.has(openId)) setOpenId(null);
  const selectedRoot = useMemo(() => {
    if (selectedFirst === undefined) return null;
    return (
      threads.find((th) => th.root.id === selectedFirst || th.replies.some((r) => r.id === selectedFirst))?.root.id ??
      null
    );
  }, [selectedFirst, threads]);
  const hovered = useCommentHover((state) => state.hovered);

  const compact = mode === 'compact';
  const sizes = items.map((item) => (compact ? metrics.marker : (heights.get(item.id) ?? ESTIMATE_PX)));
  const pinnedId = focusId ?? selectedRoot ?? openId;
  const pinned = pinnedId === null ? null : items.findIndex((item) => item.id === pinnedId);
  const tops = useMemo(
    () =>
      placeBubbles(
        items.map((item, i) => ({ anchor: item.anchor, height: sizes[i] as number })),
        metrics.stack,
        pinned === -1 ? null : pinned,
      ),
    // `sizes` is derived from `items`, `heights` and `compact`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, heights, compact, metrics.stack, pinned],
  );

  // A page wider than the canvas (zoom 160 %) has its column right of the page, beyond the viewport: it is kept inside what the
  // viewport shows, over the page's edge, rather than reached only by scrolling (DESIGN 3.5 B9).
  const columnWidth = compact ? metrics.compact : metrics.width;
  const xOf = (item: Item) => clampColumnX(item.x, view, columnWidth);
  const slotWidth = layout.width + metrics.gap + (compact ? metrics.compact : metrics.width);
  const overscan = Math.max(0, view.bottom - view.top);
  const shown = useMemo(() => {
    const set = new Set(visibleBubbles(tops, sizes, view.top - overscan, view.bottom + overscan));
    for (const id of [focusId, selectedRoot, openId]) {
      const i = id === null ? -1 : items.findIndex((item) => item.id === id);
      if (i >= 0) set.add(i);
    }
    return [...set].sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tops, view.top, view.bottom, focusId, selectedRoot, openId, items]);

  // The roving tab stop: the focused bubble, else the selected one, else the first.
  const tabId = focusId ?? selectedRoot ?? items[0]?.id ?? null;

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Re-stack motion (MOTION spell 22): after each layout, bubbles that moved slide, a new one fades in; zoom and scroll never animate.
  const restackRef = useRef(newRestackState());
  const geometry = `${layout.scale}|${layout.width}|${mode}|${rotation}`;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const reduce =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    restack(
      root,
      restackRef.current,
      geometry,
      items.map((item) => item.id),
      reduce,
    );
  }, [tops, shown, geometry, items]);
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === null) return;
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-bubble="${wanted}"], [data-marker="${wanted}"]`);
    if (element !== null && element !== undefined) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  // "Open citation" in the mini bar: focus that bubble (the popover of its marker in the compact column).
  useEffect(
    () =>
      onCitationFocus((annotId) => {
        if (!threads.some((thread) => thread.root.id === annotId)) return;
        pendingFocus.current = annotId;
        setFocusId(annotId);
        if (mode === 'compact') setOpenId(annotId);
      }),
    [threads, mode],
  );

  const select = useCallback(
    (thread: Thread) => {
      jumpToAnnotation(docId, thread.root.id, thread.root.pageId);
    },
    [docId],
  );

  const move = (from: number, direction: 1 | -1) => {
    const next = items[from + direction];
    if (next === undefined) return;
    pendingFocus.current = next.id;
    setFocusId(next.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    // Only the bubble or marker itself has these keys; its fields keep theirs.
    if (
      !(target instanceof HTMLElement) ||
      (target.dataset.bubble === undefined && target.dataset.marker === undefined)
    )
      return;
    const id = Number(target.dataset.bubble ?? target.dataset.marker);
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    if (event.key === 'ArrowDown') move(index, 1);
    else if (event.key === 'ArrowUp') move(index, -1);
    else if (event.key === 'Escape') {
      // Back to the anchor: the canvas region takes the focus.
      rootRef.current?.closest<HTMLElement>('[role="region"]')?.focus();
    } else return;
    event.preventDefault();
  };

  // The leader line (hover or focus only, and only when the bubble is off its anchor).
  const leaderFor = hovered ?? focusId;
  const leaderIndex = leaderFor === null ? -1 : items.findIndex((item) => item.id === leaderFor);
  const leaderItem = leaderIndex >= 0 ? (items[leaderIndex] as Item) : null;
  const leaderTop = leaderIndex >= 0 ? (tops[leaderIndex] as number) : 0;
  const showLeader = leaderItem !== null && Math.abs(leaderTop - leaderItem.anchor) > metrics.stack && !compact;

  return (
    <div
      ref={rootRef}
      role="list"
      aria-label={t('margin.list')}
      data-margin-column={mode}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
          setFocusId(null);
      }}
      className="pointer-events-none absolute top-0 z-canvas-annotations"
      style={{ left: 0, width: slotWidth, height: layout.height }}
    >
      {showLeader && leaderItem !== null && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute overflow-visible"
          style={{ left: xOf(leaderItem), top: 0, width: 1, height: 1 }}
        >
          <line
            x1={0}
            y1={leaderTop + metrics.stack}
            x2={leaderItem.right - xOf(leaderItem)}
            y2={leaderItem.anchor}
            className="stroke-control-border"
            strokeWidth={1}
          />
        </svg>
      )}
      {shown.map((i) => {
        const item = items[i] as Item;
        const top = tops[i] as number;
        const selected = selectedRoot === item.id;
        const name = item.thread.root.author ?? t('margin.noAuthor');
        if (compact) {
          const open = openId === item.id;
          return (
            <div
              key={item.id}
              role="listitem"
              data-item={item.id}
              data-top={top}
              className="pointer-events-auto absolute"
              style={{ top, left: xOf(item) + (metrics.compact - metrics.marker) / 2 }}
            >
              <Marker
                id={item.id}
                author={item.thread.root.author}
                citation={item.thread.root.cite !== undefined}
                label={
                  item.thread.root.cite === undefined
                    ? t('margin.marker', { author: name })
                    : t('citation.aria', {
                        page:
                          citations.find((c) => c.id === item.id)?.locator ??
                          String(pageNumberOf(docId, item.thread.root.pageId)),
                      })
                }
                selected={selected || open}
                onFocus={() => setFocusId(item.id)}
                onClick={() => {
                  setOpenId(open ? null : item.id);
                  select(item.thread);
                }}
              />
              {open && (
                <div
                  className="absolute"
                  style={{ top: 0, right: metrics.marker + metrics.stack, width: metrics.width }}
                >
                  <Shown
                    docId={docId}
                    thread={item.thread}
                    selected
                    tabStop
                    now={now}
                    onEscape={() => setOpenId(null)}
                    onSelect={select}
                  />
                </div>
              )}
            </div>
          );
        }
        return (
          <div
            key={item.id}
            role="listitem"
            data-item={item.id}
            data-top={top}
            ref={measure}
            onFocus={() => setFocusId(item.id)}
            className="pointer-events-auto absolute"
            style={{ top, left: xOf(item), width: metrics.width }}
          >
            <Shown
              docId={docId}
              thread={item.thread}
              selected={selected}
              tabStop={tabId === item.id}
              now={now}
              onSelect={select}
            />
          </div>
        );
      })}
    </div>
  );
}
