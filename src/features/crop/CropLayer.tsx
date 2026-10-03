import { memo, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import type { PageCrop, PageSlotInfo } from '../../api/pages';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { fileRotationOf } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import {
  normalizeRotation,
  overlayBox,
  swapsSides,
  totalRotation,
  unrotatedSize,
  viewToPage,
} from '../viewer/transform';
import { applyCrop } from './actions';
import {
  HANDLES,
  MOVE,
  SNAP_PX,
  boxOf,
  cursorOf,
  deltaToPage,
  dragMargins,
  drawMargins,
  handleOfSide,
  pageSideOf,
  viewHandle,
  type CropFrame,
  type Handle,
} from './geometry';
import { installCropMode } from './mode';
import { keyOf, useCrop, useCropTarget } from './store';

// The mode follows the Crop tool from the moment a canvas exists.
installCropMode();

/** A pointer movement of less than this, in px, is a click and does not draw a rectangle. */
const CLICK_PX = 3;

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const HANDLE_LABELS = {
  '-1:-1': 'crop.handle.nw',
  '0:-1': 'crop.handle.n',
  '1:-1': 'crop.handle.ne',
  '-1:0': 'crop.handle.w',
  '1:0': 'crop.handle.e',
  '-1:1': 'crop.handle.sw',
  '0:1': 'crop.handle.s',
  '1:1': 'crop.handle.se',
} as const;

/** The label of a handle by where it is on screen. */
function handleLabel(view: Handle) {
  return HANDLE_LABELS[`${view.x}:${view.y}` as keyof typeof HANDLE_LABELS];
}

interface Gesture {
  /** `null` draws a new rectangle from `from`. */
  handle: Handle | null;
  pointerId: number;
  /** The pointer at the start, in px of the page's box, and in page space. */
  startPx: { x: number; y: number };
  from: { x: number; y: number };
  start: PageCrop;
  moved: boolean;
}

/**
 * Canvas layer of the crop rectangle and shade (DESIGN 3.37), on the current page while the Crop tool is active. It lives in page space
 * (before the file's `/Rotate`) turned by the same transform as the other layers; the margins it edits are measured from the MediaBox.
 */
export const CropLayer = memo(function CropLayer(props: PageLayerProps) {
  const active = useUi((state) => state.activeTool === 'crop');
  const target = useCropTarget();
  if (
    !active ||
    !props.ready ||
    target === null ||
    target.docId !== props.docId ||
    target.slot.id !== props.pageIndex
  ) {
    return null;
  }
  const number = target.slots.findIndex((slot) => slot.id === target.slot.id) + 1;
  return <CropRect {...props} slot={target.slot} number={number} frame={target.frame} margins={target.margins} />;
});

function CropRect({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  slot,
  number,
  frame,
  margins,
}: PageLayerProps & { slot: PageSlotInfo; number: number; frame: CropFrame; margins: PageCrop }) {
  const t = useT();
  const outer = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  const view = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = unrotatedSize([widthPt, heightPt], file);
  const total = totalRotation(file, view);
  const shownWidthPt = swapsSides(view) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;
  const key = keyOf(docId, pageIndex);
  const snap = SNAP_PX / pxPerPt;

  const set = (next: PageCrop) => useCrop.getState().setMargins(key, next);

  /** A pointer position in px of the page's box, and in page space (points, the shown part's own coordinates). */
  const locate = (event: PointerEvent) => {
    const rect = outer.current?.getBoundingClientRect();
    const px = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    return { px, at: viewToPage({ x: px.x / pxPerPt, y: px.y / pxPerPt }, page, total) };
  };

  const begin = (event: PointerEvent<HTMLElement>, handle: Handle | null) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const { px, at } = locate(event);
    gesture.current = { handle, pointerId: event.pointerId, startPx: px, from: at, start: margins, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (g === null || g.pointerId !== event.pointerId) return;
    const { px, at } = locate(event);
    if (!g.moved && Math.hypot(px.x - g.startPx.x, px.y - g.startPx.y) < CLICK_PX) return;
    g.moved = true;
    if (g.handle === null) {
      set(drawMargins(g.from, at, frame, snap));
      return;
    }
    set(dragMargins(g.start, g.handle, at.x - g.from.x, at.y - g.from.y, frame, { keepAspect: event.shiftKey, snap }));
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void applyCrop(docId, slot, margins);
      return;
    }
    const arrow = ARROWS[event.key];
    if (arrow === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const delta = deltaToPage(arrow[0] * step, arrow[1] * step, total);
    if (event.altKey) {
      // Alt resizes the edge that trails on screen: the right one for the horizontal arrows, the bottom one for the vertical.
      const side = pageSideOf(arrow[0] !== 0 ? 'right' : 'bottom', total);
      set(dragMargins(margins, handleOfSide(side), delta.x, delta.y, frame));
    } else {
      set(dragMargins(margins, MOVE, delta.x, delta.y, frame));
    }
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>, handle: Handle) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const arrow = ARROWS[event.key];
    if (arrow === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    // The arrow moves the handle on screen; dragMargins takes the movement in page space and the handle's page-space side.
    const delta = deltaToPage(arrow[0] * step, arrow[1] * step, total);
    set(dragMargins(margins, handle, delta.x, delta.y, frame));
  };

  const box = boxOf(margins, frame);
  const layout = overlayBox(boxWidth, boxHeight, page, pxPerPt, total);
  const style = { ...layout, transformOrigin: 'center', '--page-scale': pxPerPt } as CSSProperties;
  const [w, h] = page;
  const shade = 'absolute bg-transparent pointer-events-none';
  const rectStyle = (x: number, y: number, rw: number, rh: number): CSSProperties => ({
    left: x,
    top: y,
    width: Math.max(0, rw),
    height: Math.max(0, rh),
  });

  return (
    <div ref={outer} data-crop-layer="" className="pointer-events-none absolute inset-0 z-canvas-annotations">
      <div className="absolute" style={style}>
        <div
          data-crop-catcher=""
          className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={(event) => begin(event, null)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        {[
          rectStyle(0, 0, w, box.y),
          rectStyle(0, box.y + box.h, w, h - box.y - box.h),
          rectStyle(0, box.y, box.x, box.h),
          rectStyle(box.x + box.w, box.y, w - box.x - box.w, box.h),
        ].map((placed, index) => (
          <div key={index} data-crop-shade="" className={shade} style={placed} />
        ))}
        <div
          role="group"
          tabIndex={0}
          aria-label={t('crop.rectLabel', { n: number })}
          data-crop-rect=""
          className="pointer-events-auto absolute cursor-move touch-none"
          style={{ ...rectStyle(box.x, box.y, box.w, box.h) }}
          onPointerDown={(event) => begin(event, MOVE)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={onKeyDown}
        />
        {HANDLES.map((handle) => (
          <div
            key={`${handle.x}:${handle.y}`}
            data-annot-handle=""
            data-crop-handle=""
            role="button"
            tabIndex={0}
            aria-label={t(handleLabel(viewHandle(handle, total)))}
            style={{
              left: box.x + ((handle.x + 1) / 2) * box.w,
              top: box.y + ((handle.y + 1) / 2) * box.h,
              cursor: cursorOf(viewHandle(handle, total)),
            }}
            onPointerDown={(event) => begin(event, handle)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(event) => onHandleKeyDown(event, handle)}
          />
        ))}
      </div>
    </div>
  );
}
