import { useReducedMotion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import { cx } from '../../components/cx';
import { tokenPx } from '../../components/tokens';
import type { RenderScheduler } from '../../engine/renderScheduler';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { launchJump } from '../viewer/openTransition';
import { useViewer } from '../viewer/useViewer';
import { useDevicePixelRatio } from '../viewer/useDevicePixelRatio';
import { deletePages, dropPages, isReadOnly, moveByKeys } from './commands';
import {
  arrowTarget,
  cellOrigin,
  cellsInRect,
  contentHeight,
  gridMetrics,
  insertionAt,
  markerRect,
  revealTop,
  selectByClick,
  visibleRange,
  type GridSpacing,
  type Insertion,
} from './grid';
import { OrganizeCell } from './OrganizeCell';
import { DragCard } from './DragCard';
import { readSlots, useSlots } from './source';
import { selectionOf, useOrganize } from './store';

/** Pixels the pointer must travel from a page before a drag begins (DESIGN 3.28). */
export const DRAG_THRESHOLD_PX = 4;
/** Within this many px of the scroller's top or bottom edge a drag scrolls it. */
const EDGE_PX = 48;
const MAX_SCROLL_PER_FRAME = 24;

function readSpacing(): GridSpacing {
  return {
    padding: tokenPx('--space-6', 24),
    gap: tokenPx('--space-6', 24),
    cellPad: tokenPx('--space-1', 4),
    labelGap: tokenPx('--space-2', 8),
    labelHeight: tokenPx('--pill-height', 20),
  };
}

function optionOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[role="option"]') : null;
}

interface Pending {
  kind: 'cell' | 'marquee';
  id: number;
  x: number;
  y: number;
  /** A plain press on a page that was selected: a release without a drag selects it alone. */
  collapse: boolean;
  /** The selection a marquee adds to (Shift or primary held), else empty. */
  base: readonly number[];
}

interface Drag {
  ids: readonly number[];
}

interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OrganizeGridProps {
  docId: number;
  scheduler?: RenderScheduler;
}

/**
 * The page grid of the organize mode (DESIGN 3.28): a virtualized `listbox` (multi-selectable) of the document's pages, as many
 * columns as fit. Pointer: a click selects (primary toggles, Shift ranges), a drag on empty space draws a marquee, a drag from a page
 * lifts the selection into a card and shows a 2 px insertion marker in the nearest gap (the edges scroll); a drop sends one move
 * command. Keys: arrows move the focus (Shift extends), Space toggles, primary+A selects all, Alt+arrows move the selection,
 * Delete deletes, Enter goes back to the viewer at the focused page. Esc cancels a drag, else it leaves the mode (the shell).
 */
export function OrganizeGrid({ docId, scheduler }: OrganizeGridProps) {
  const t = useT();
  const reduce = useReducedMotion() === true;
  const slots = useSlots(docId);
  const thumb = useOrganize((state) => state.thumb);
  const selection = useOrganize((state) => selectionOf(state, docId));
  const pulseState = useOrganize((state) => state.pulse);
  const pixelRatio = useDevicePixelRatio();
  const [spacing] = useState(readSpacing);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  // The marquee is drawn from a ref in an animation frame: only whether it is on is state, so a move is no render of the grid.
  const [marqueeOn, setMarqueeOn] = useState(false);
  const marqueeEl = useRef<HTMLDivElement | null>(null);
  const marqueeRect = useRef<MarqueeRect | null>(null);
  const marqueeHits = useRef('');
  const marqueeFrame = useRef(0);
  const pending = useRef<Pending | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const wantFocus = useRef<number | null>(null);
  const readOnly = isReadOnly(docId);

  const count = slots.length;
  const ids = useMemo(() => slots.map((slot) => slot.id), [slots]);
  const metrics = useMemo(() => gridMetrics(box.width, thumb, spacing), [box.width, thumb, spacing]);
  const selected = useMemo(() => new Set(selection.selected), [selection.selected]);
  const focusIndex = Math.max(0, ids.indexOf(selection.focus ?? -1));
  const focusId = ids[focusIndex] ?? null;
  const measured = box.width > 0 && box.height > 0;

  useEffect(() => {
    const region = scroller.current;
    if (region === null) return;
    const observer = new ResizeObserver(() => {
      const next = { width: region.clientWidth, height: region.clientHeight };
      setBox((previous) => (previous.width === next.width && previous.height === next.height ? previous : next));
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  // The focus is always a page that exists (a delete or an undo may have taken it).
  useEffect(() => {
    if (count > 0 && selection.focus !== focusId) useOrganize.getState().setSelection(docId, { focus: focusId });
  }, [count, docId, focusId, selection.focus]);

  const range = useMemo(
    () => (measured ? visibleRange(metrics, count, scrollTop, box.height) : null),
    [measured, metrics, count, scrollTop, box.height],
  );
  const mounted = useMemo(() => {
    const set = new Set<number>();
    if (range !== null) for (let index = range.first; index <= range.last; index += 1) set.add(index);
    if (measured && count > 0) set.add(focusIndex);
    return [...set].sort((a, b) => a - b);
  }, [range, measured, count, focusIndex]);

  const reveal = useCallback(
    (index: number) => {
      const region = scroller.current;
      if (region === null) return;
      const target = revealTop(metrics, index, region.scrollTop, region.clientHeight);
      if (target !== null) region.scrollTop = target;
    },
    [metrics],
  );

  const focusCell = useCallback(
    (id: number) => {
      const index = readSlots(docId).findIndex((slot) => slot.id === id);
      if (index < 0) return;
      reveal(index);
      useOrganize.getState().setSelection(docId, { focus: id });
      wantFocus.current = id;
      const element = scroller.current?.querySelector<HTMLElement>(`[data-page-id="${id}"]`);
      if (element !== null && element !== undefined) {
        element.focus({ preventScroll: true });
        wantFocus.current = null;
      }
    },
    [docId, reveal],
  );

  // A cell that was asked to take the focus and was not mounted yet takes it once it is. On entering, the focused page takes it.
  const entered = useRef(false);
  useLayoutEffect(() => {
    if (!measured || focusId === null) return;
    if (!entered.current) {
      entered.current = true;
      reveal(focusIndex);
      wantFocus.current = focusId;
    }
    const wanted = wantFocus.current;
    if (wanted === null) return;
    const element = scroller.current?.querySelector<HTMLElement>(`[data-page-id="${wanted}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      wantFocus.current = null;
    }
  });

  // Leaving the mode: the viewer returns at the focused page, and its thumbnail flies into it (MOTION 4.6). A layout cleanup, so the
  // grid's DOM is still there to measure. Closing the document or switching away does not count as leaving.
  const latest = useRef({ focusIndex, docId });
  useLayoutEffect(() => {
    latest.current = { focusIndex, docId };
  });
  useLayoutEffect(() => {
    const region = scroller.current;
    return () => {
      if (useUi.getState().activeTool === 'pages') return;
      const { focusIndex: index, docId: id } = latest.current;
      const image = region?.querySelector<HTMLImageElement>(`[role="option"][data-index="${index}"] img`);
      if (image !== null && image !== undefined && image.src !== '' && !reduce) {
        const rect = image.getBoundingClientRect();
        launchJump(id, index, {
          kind: 'image',
          src: image.src,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        });
      }
      useViewer.getState().goToPage(index);
    };
  }, [reduce]);

  // Keep the scroll position when the width changes the rows: the page at the top stays near it.
  const toContent = useCallback((clientX: number, clientY: number) => {
    const region = scroller.current;
    const rect = region?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) + (region?.scrollTop ?? 0) };
  }, []);

  // Edge scrolling while a drag is on: the insertion follows the pointer as the content moves under it.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const region = scroller.current;
      if (region !== null) {
        const rect = region.getBoundingClientRect();
        const { x, y } = pointer.current;
        let speed = 0;
        if (y < rect.top + EDGE_PX) speed = -Math.min(1, (rect.top + EDGE_PX - y) / EDGE_PX);
        else if (y > rect.bottom - EDGE_PX) speed = Math.min(1, (y - (rect.bottom - EDGE_PX)) / EDGE_PX);
        if (speed !== 0) region.scrollTop += Math.round(speed * MAX_SCROLL_PER_FRAME);
        const point = toContent(x, y);
        setInsertion((previous) => {
          const next = insertionAt(metrics, count, point.x, point.y);
          return previous !== null && previous.index === next.index && previous.col === next.col ? previous : next;
        });
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [dragging, metrics, count, toContent]);

  // The marquee box and the selection under it, once per frame. The selection is set only when what it touches changes.
  const applyMarquee = () => {
    marqueeFrame.current = 0;
    const down = pending.current;
    const box = marqueeRect.current;
    if (down === null || down.kind !== 'marquee' || box === null) return;
    const rect = {
      left: Math.min(box.x0, box.x1),
      right: Math.max(box.x0, box.x1),
      top: Math.min(box.y0, box.y1),
      bottom: Math.max(box.y0, box.y1),
    };
    const element = marqueeEl.current;
    if (element !== null) {
      element.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      element.style.width = `${rect.right - rect.left}px`;
      element.style.height = `${rect.bottom - rect.top}px`;
    }
    const hits = cellsInRect(metrics, count, rect).map((index) => ids[index] ?? -1);
    const key = hits.join(',');
    if (key === marqueeHits.current) return;
    marqueeHits.current = key;
    setSel({ selected: [...new Set([...down.base, ...hits])] });
  };
  const endMarquee = () => {
    if (marqueeFrame.current !== 0) window.cancelAnimationFrame(marqueeFrame.current);
    marqueeFrame.current = 0;
    marqueeRect.current = null;
    marqueeHits.current = '';
    setMarqueeOn(false);
  };
  useEffect(
    () => () => {
      if (marqueeFrame.current !== 0) window.cancelAnimationFrame(marqueeFrame.current);
    },
    [],
  );

  const cancelDrag = useCallback(() => {
    pending.current = null;
    setDrag(null);
    setInsertion(null);
  }, []);

  // Esc during a drag puts the card back and does not leave the mode: this runs before the shell's own Esc handler.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelDrag();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragging, cancelDrag]);

  const setSel = (change: Parameters<ReturnType<typeof useOrganize.getState>['setSelection']>[1]) =>
    useOrganize.getState().setSelection(docId, change);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target instanceof HTMLInputElement) return;
    const toggle = event.ctrlKey || event.metaKey;
    const mods = { toggle, range: event.shiftKey };
    const option = optionOf(event.target);
    const point = toContent(event.clientX, event.clientY);
    pointer.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (option !== null) {
      const id = Number(option.dataset.pageId);
      let collapse = false;
      if (mods.toggle || mods.range) {
        setSel({ ...selectByClick(ids, selection.selected, selection.anchor, id, mods), focus: id });
      } else if (selected.has(id)) {
        collapse = true;
        setSel({ focus: id });
      } else {
        setSel({ selected: [id], anchor: id, focus: id });
      }
      option.focus({ preventScroll: true });
      pending.current = { kind: 'cell', id, x: event.clientX, y: event.clientY, collapse, base: [] };
      event.preventDefault();
      return;
    }
    const base = mods.toggle || mods.range ? selection.selected : [];
    if (base.length === 0) setSel({ selected: [] });
    // A read-only document has nothing to lift or act on, so empty space starts no marquee.
    if (readOnly) return;
    pending.current = { kind: 'marquee', id: -1, x: point.x, y: point.y, collapse: false, base };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const down = pending.current;
    if (down === null) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (down.kind === 'cell') {
      // The card and the marker follow the pointer from the animation frame (the card's own, and the tick above): no render here.
      if (drag !== null || readOnly) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < DRAG_THRESHOLD_PX) return;
      const lifted = selected.has(down.id) ? ids.filter((id) => selected.has(id)) : [down.id];
      setDrag({ ids: lifted });
      const point = toContent(event.clientX, event.clientY);
      setInsertion(insertionAt(metrics, count, point.x, point.y));
      return;
    }
    const point = toContent(event.clientX, event.clientY);
    marqueeRect.current = { x0: down.x, y0: down.y, x1: point.x, y1: point.y };
    setMarqueeOn(true);
    if (marqueeFrame.current === 0) marqueeFrame.current = window.requestAnimationFrame(applyMarquee);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const down = pending.current;
    pending.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (down?.kind === 'marquee') {
      pending.current = down;
      applyMarquee();
      pending.current = null;
    }
    endMarquee();
    if (down === null) return;
    if (drag !== null && insertion !== null) {
      const { ids: moved } = drag;
      const at = insertion.index;
      cancelDrag();
      dropPages(docId, moved, at).catch(() => undefined);
      return;
    }
    cancelDrag();
    if (down.kind === 'cell' && down.collapse) setSel({ selected: [down.id], anchor: down.id });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const option = optionOf(event.target);
    if (option === null || event.defaultPrevented) return;
    const id = Number(option.dataset.pageId);
    const index = ids.indexOf(id);
    const primary = event.ctrlKey || event.metaKey;
    if (event.altKey) {
      const delta =
        event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowRight'
            ? 1
            : event.key === 'ArrowUp'
              ? -metrics.cols
              : event.key === 'ArrowDown'
                ? metrics.cols
                : 0;
      if (delta === 0) return;
      event.preventDefault();
      // The pages under the focus move when nothing is selected.
      if (selection.selected.length === 0) setSel({ selected: [id], anchor: id });
      moveByKeys(docId, delta).catch(() => undefined);
      return;
    }
    if (primary) {
      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSel({ selected: ids, anchor: ids[0] ?? null });
      }
      return;
    }
    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        deletePages(docId).catch(() => undefined);
        return;
      case 'Enter':
        event.preventDefault();
        useUi.getState().releaseTool();
        return;
      case ' ':
        event.preventDefault();
        setSel({
          ...selectByClick(ids, selection.selected, selection.anchor, id, { toggle: true, range: false }),
          focus: id,
        });
        return;
      default:
        break;
    }
    const target = arrowTarget(metrics, count, index, event.key);
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (target === null) return;
    const to = ids[target];
    if (to === undefined) return;
    if (event.shiftKey) {
      const anchor = selection.anchor ?? id;
      setSel({ ...selectByClick(ids, selection.selected, anchor, to, { toggle: false, range: true }), focus: to });
    } else {
      setSel({ focus: to });
    }
    focusCell(to);
  };

  const marker =
    insertion !== null && drag !== null ? markerRect(metrics, insertion, tokenPx('--insert-marker', 2)) : null;
  const draggedSet = useMemo(() => new Set(drag?.ids ?? []), [drag]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cx(
        'min-h-0 flex-auto overflow-y-auto overflow-x-hidden [overflow-anchor:none]',
        dragging && 'cursor-grabbing',
      )}
    >
      <div
        role="listbox"
        aria-multiselectable="true"
        aria-readonly={readOnly ? 'true' : undefined}
        aria-label={t('toolbar.tool.pages')}
        onKeyDown={onKeyDown}
        className="relative w-full"
        style={{ height: contentHeight(metrics, count) }}
      >
        {mounted.map((index) => {
          const slot = slots[index];
          if (slot === undefined) return null;
          const origin = cellOrigin(metrics, index);
          return (
            <OrganizeCell
              key={slot.id}
              docId={docId}
              slot={slot}
              index={index}
              total={count}
              left={origin.left}
              top={origin.top}
              thumb={thumb}
              width={metrics.cellWidth}
              height={metrics.cellHeight}
              pixelRatio={pixelRatio}
              selected={selected.has(slot.id)}
              tabStop={slot.id === focusId}
              active={range !== null && index >= range.first && index <= range.last}
              dragged={draggedSet.has(slot.id)}
              pulseKey={pulseState.ids.includes(slot.id) ? pulseState.nonce : 0}
              readOnly={readOnly}
              scheduler={scheduler}
            />
          );
        })}
        {marker !== null && (
          <div
            aria-hidden="true"
            data-insert-marker=""
            className="pointer-events-none absolute start-0 top-0 w-insert-marker rounded-pill bg-accent"
            style={{ transform: `translate(${marker.left}px, ${marker.top}px)`, height: marker.height }}
          />
        )}
        {marqueeOn && (
          <div
            ref={marqueeEl}
            aria-hidden="true"
            data-marquee=""
            className="pointer-events-none absolute start-0 top-0 border border-accent"
          />
        )}
      </div>
      {dragging && (
        <DragCard
          docId={docId}
          ids={drag.ids}
          pointer={pointer}
          thumb={thumb}
          pixelRatio={pixelRatio}
          scheduler={scheduler}
        />
      )}
    </div>
  );
}
