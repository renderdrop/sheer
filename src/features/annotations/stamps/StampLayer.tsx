import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { Point, Rect } from '../../../api/wire';
import { useLocale, useT } from '../../../i18n';
import { useUi } from '../../../stores/ui';
import { normalizeRotation, overlayBox, swapsSides, viewToPage } from '../../viewer/transform';
import { clampToPage, isDrag } from '../create/geometry';
import { placeStamp } from './actions';
import {
  GHOST_STEP_FINE_PX,
  GHOST_STEP_PX,
  clickBox,
  dragBox,
  defaultSize,
  faceOf,
  ghostStep,
  type Preset,
} from './model';
import { StampArt } from './StampArt';
import { useStamp } from './store';

export interface StampLayerProps {
  docId: number;
  /** Zero-based; it is also the page id of the model while pages cannot change. */
  pageIndex: number;
  /** The page in page space: points, before the file's `/Rotate`. */
  pageBox: { width: number; height: number };
  /** Scale (px per point) and the rotation that is applied to page space in total. */
  transform: { pxPerPt: number; rotation: number };
  /** A press on a movable annotation moves it instead of placing the stamp: true if it took the press (ADR-105). */
  grab?: (event: ReactPointerEvent, at: Point) => boolean;
}

/** The ghost is shown at this opacity (DESIGN 3.14 ST3); the stamp that is placed fades in by the annotation layer's own fade. */
const GHOST_OPACITY = 0.5;
/** The canvas region that scrolls the pages (Canvas.tsx). */
const SCROLL_SURFACE = '[role="region"]';

interface Drag {
  pointerId: number;
  start: Point;
  moved: boolean;
}

/**
 * The layer that places the armed stamp on one page (DESIGN 3.14 ST3). It takes the pointer only while the Stempel tool is active. A
 * ghost at 50 % follows the pointer; a click places the stamp at its default size centred on the click, a drag sizes it with the aspect
 * kept. After a choice made with the keyboard the ghost starts in the centre of the visible page, the arrows move it (Shift: fine) and
 * Enter places it. Esc leaves the tool.
 */
export function StampLayer(props: StampLayerProps) {
  const active = useUi((s) => s.activeTool === 'stamp');
  if (!active) return null;
  return <ActiveLayer {...props} />;
}

function ActiveLayer({ docId, pageIndex, pageBox, transform, grab }: StampLayerProps) {
  const t = useT();
  const locale = useLocale();
  const choice = useStamp((s) => s.choice);
  const keyboard = useStamp((s) => s.keyboard);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [dragged, setDragged] = useState<Rect | null>(null);
  /** The keyboard ghost in client px (so the arrows move it by screen px whatever the zoom and rotation are). */
  const [kbd, setKbd] = useState<{ client: Point; page: Point } | null>(null);

  const rotation = normalizeRotation(transform.rotation);
  const page = useMemo(() => [pageBox.width, pageBox.height] as const, [pageBox.width, pageBox.height]);
  const viewW = swapsSides(rotation) ? page[1] : page[0];
  const viewH = swapsSides(rotation) ? page[0] : page[1];

  const face = useMemo(
    () => faceOf(choice, (preset: Preset) => t(`stamp.${preset}`), locale, new Date()),
    [choice, locale, t],
  );
  const size = useMemo(() => (face === null ? null : defaultSize(face)), [face]);

  const toPage = (event: { clientX: number; clientY: number }): Point | null => {
    const element = surface.current;
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const view = {
      x: ((event.clientX - rect.left) / rect.width) * viewW,
      y: ((event.clientY - rect.top) / rect.height) * viewH,
    };
    return clampToPage(viewToPage(view, page, rotation), page[0], page[1]);
  };

  // Esc leaves the tool; the window sees it even when focus is on the canvas.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // An open picker takes the Esc first (its own layer sees it before this one).
      if (useStamp.getState().pickerOpen) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = null;
      useStamp.getState().setKeyboard(false);
      useUi.getState().releaseTool();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /** Puts the keyboard ghost at a client position (and remembers where that is on the page); never during render. */
  const setKbdAt = (client: Point | null) => {
    const page = client === null ? null : toPage({ clientX: client.x, clientY: client.y });
    setKbd(client === null || page === null ? null : { client, page });
  };

  // A choice made with the keyboard: the ghost starts in the centre of the visible part of the page (only the page that is there).
  useEffect(() => {
    if (!keyboard) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the keyboard ghost ends with the mode
      setKbdAt(null);
      return;
    }
    const element = surface.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const scroller = element.closest(SCROLL_SURFACE)?.getBoundingClientRect();
    const cx = scroller !== undefined ? scroller.left + scroller.width / 2 : window.innerWidth / 2;
    const cy = scroller !== undefined ? scroller.top + scroller.height / 2 : window.innerHeight / 2;
    setKbdAt(cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom ? null : { x: cx, y: cy });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ghost starts once per choice made with the keyboard
  }, [keyboard]);

  const placeBox = (box: Rect) => {
    if (face === null) return;
    setPointer(null);
    setDragged(null);
    setKbdAt(null);
    void placeStamp(docId, pageIndex, box, face, choice.tone);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current !== null) return;
    const at = toPage(event);
    if (at === null) return;
    if (grab?.(event, at) === true) return;
    event.preventDefault();
    const element = surface.current;
    if (element !== null && typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: at, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const at = toPage(event);
    setPointer(at);
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId || at === null || size === null) return;
    if (!d.moved && !isDrag(d.start, at)) return;
    d.moved = true;
    setDragged(dragBox(d.start, at, size, page));
  };

  const release = (pointerId: number) => {
    const element = surface.current;
    if (element !== null && typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    drag.current = null;
    release(event.pointerId);
    if (size === null) return;
    const end = toPage(event) ?? d.start;
    placeBox(d.moved || isDrag(d.start, end) ? dragBox(d.start, end, size, page) : clickBox(d.start, size, page));
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    drag.current = null;
    release(event.pointerId);
    setDragged(null);
  };

  // Arrows move the keyboard ghost 8 px (Shift: 1 px); Enter places it. The listener is added once and calls the newest handler.
  const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    onKeyRef.current = (event) => {
      if (kbd === null || size === null || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [role^="menu"], [role="dialog"]') !== null
      )
        return;
      const step = ghostStep(event.key);
      if (step !== null) {
        event.preventDefault();
        const px = event.shiftKey ? GHOST_STEP_FINE_PX : GHOST_STEP_PX;
        setKbdAt({ x: kbd.client.x + step.x * px, y: kbd.client.y + step.y * px });
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      placeBox(clickBox(kbd.page, size, page));
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onKeyRef.current(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const box = overlayBox(viewW * transform.pxPerPt, viewH * transform.pxPerPt, page, transform.pxPerPt, rotation);
  const ghostBox =
    size === null
      ? null
      : dragged !== null
        ? dragged
        : kbd !== null
          ? clickBox(kbd.page, size, page)
          : pointer !== null
            ? clickBox(pointer, size, page)
            : null;
  return (
    <div
      ref={surface}
      data-stamp-layer=""
      style={{ zIndex: 'var(--z-canvas-annotations)' }}
      className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setPointer(null)}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute overflow-visible"
        width={box.width}
        height={box.height}
        viewBox={`0 0 ${page[0]} ${page[1]}`}
        style={{ left: box.left, top: box.top, transform: box.transform, transformOrigin: 'center' }}
      >
        {ghostBox === null || face === null ? null : (
          <g data-stamp-ghost="" transform={`translate(${ghostBox.x} ${ghostBox.y})`} opacity={GHOST_OPACITY}>
            <StampArt w={ghostBox.w} h={ghostBox.h} text={face.text} date={face.date} tone={choice.tone} />
          </g>
        )}
      </svg>
    </div>
  );
}
