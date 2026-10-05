import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { Point, Rect } from '../../../api/wire';
import { announce } from '../../../components';
import { useT } from '../../../i18n';
import { useUi } from '../../../stores/ui';
import { clampToPage, isDrag } from '../../annotations/create/geometry';
import { normalizeRotation, overlayBox, swapsSides, viewToPage } from '../../viewer/transform';
import { SEAL_HANDLES, boxAtClick, boxFromDrag, nudge, resizeBy, resizeTo } from './geometry';
import { useIdentities } from './identities';
import { sealDate } from './SealPreview';
import { useCertSign } from './store';

export interface CertPlacementLayerProps {
  docId: number;
  /** Zero-based page index, also the page id while pages cannot change. */
  pageIndex: number;
  /** The page in page space: points, before the file's `/Rotate`. */
  pageBox: { width: number; height: number };
  /** Scale (px per point) and the rotation applied to page space in total. */
  transform: { pxPerPt: number; rotation: number };
}

const OUTLINE_PT = 1;
const DASH = '4 3';
const SCROLL_SURFACE = '[role="region"]';
/** The visual and the pointer size of a resize handle, in CSS px (DESIGN 3.8 L6). */
const HANDLE_PX = 8;
const HANDLE_HIT_PX = 24;

type Handle = (typeof SEAL_HANDLES)[number];

/** The resize cursor of a handle, seen on screen: a quarter turn swaps the axes. */
function handleCursor({ hx, hy }: Handle, quarter: boolean): string {
  const diagonal = hx !== 0 && hy !== 0;
  if (diagonal) return hx * hy > 0 !== quarter ? 'nwse-resize' : 'nesw-resize';
  return (hx !== 0) !== quarter ? 'ew-resize' : 'ns-resize';
}

/** The unit step of an arrow key on the screen. */
const ARROWS: Record<string, { x: number; y: number } | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The layer that places the seal of a certificate signature on one page (DESIGN 3.8 S3 step 1). It takes the pointer only while the
 * Zertifikat tool is on: a click places the default box, a drag draws one; the placeholder then stays (Enter opens the sheet, the
 * arrows move it by 1 pt, Shift by 10 pt, Esc or Delete discards it). Mount it beside the visual `PlacementLayer`.
 */
export function CertPlacementLayer(props: CertPlacementLayerProps) {
  const active = useCertSign((state) => state.active);
  if (!active) return null;
  return <ActiveLayer {...props} />;
}

function ActiveLayer({ docId, pageIndex, pageBox, transform }: CertPlacementLayerProps) {
  const t = useT();
  const surface = useRef<HTMLDivElement>(null);
  const box = useCertSign((state) => state.box);
  const certId = useCertSign((state) => state.identityId);
  const identities = useIdentities((state) => state.items);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const [resizing, setResizing] = useState<Handle | null>(null);
  const rotation = normalizeRotation(transform.rotation);
  const page = useMemo(() => [pageBox.width, pageBox.height] as const, [pageBox.width, pageBox.height]);
  const viewW = swapsSides(rotation) ? page[1] : page[0];
  const viewH = swapsSides(rotation) ? page[0] : page[1];
  const mine = box !== null && box.docId === docId && box.pageIndex === pageIndex;

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

  const place = (rect: Rect) => {
    const state = useCertSign.getState();
    state.setBox({ docId, pageIndex, rect });
    state.openDialog();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = toPage(event);
    if (at === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ from: at, to: at });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizing !== null) {
      const at = toPage(event);
      const current = useCertSign.getState().box;
      if (at !== null && current !== null) {
        useCertSign.getState().setBox({ ...current, rect: resizeTo(current.rect, resizing.hx, resizing.hy, at, page) });
      }
      return;
    }
    if (drag === null) return;
    const at = toPage(event);
    if (at !== null) setDrag({ from: drag.from, to: at });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizing !== null) {
      setResizing(null);
      return;
    }
    if (drag === null) return;
    const at = toPage(event) ?? drag.to;
    setDrag(null);
    place(isDrag(drag.from, at) ? boxFromDrag(drag.from, at, page) : boxAtClick(drag.from, page));
  };

  // The keyboard (S3): Enter places or reopens, arrows move, Esc and Delete discard. The newest handler runs, so it never sees a stale box.
  const onKey = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    onKey.current = (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, button, [role^="menu"]') !== null)
        return;
      if (event.key === 'Escape' || event.key === 'Delete') {
        if (event.key === 'Delete' && box === null) return;
        event.preventDefault();
        event.stopPropagation();
        useCertSign.getState().reset();
        useUi.getState().releaseTool();
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      const arrow = ARROWS[event.key];
      if (event.altKey) {
        // Alt+arrows resize from the bottom-right corner, Alt+Shift by 10 pt (L6): Right and Down grow, Left and Up shrink.
        if (arrow === undefined || box === null || !mine) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const origin = viewToPage({ x: 0, y: 0 }, page, rotation);
        const delta = viewToPage({ x: arrow.x * step, y: arrow.y * step }, page, rotation);
        const corner = viewToPage({ x: 1, y: 1 }, page, rotation);
        const rect = resizeBy(
          box.rect,
          corner.x >= origin.x ? 1 : -1,
          corner.y >= origin.y ? 1 : -1,
          delta.x - origin.x,
          delta.y - origin.y,
          page,
        );
        useCertSign.getState().setBox({ ...box, rect });
        announce(t('cert.placeholder.size', { w: Math.round(rect.w), h: Math.round(rect.h) }));
        return;
      }
      if (event.key === 'Enter') {
        if (box !== null) {
          if (!mine) return;
          event.preventDefault();
          useCertSign.getState().openDialog();
          return;
        }
        const element = surface.current;
        if (element === null) return;
        const rect = element.getBoundingClientRect();
        const scroller = element.closest(SCROLL_SURFACE)?.getBoundingClientRect();
        const cx = scroller !== undefined ? scroller.left + scroller.width / 2 : window.innerWidth / 2;
        const cy = scroller !== undefined ? scroller.top + scroller.height / 2 : window.innerHeight / 2;
        if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return;
        const at = toPage({ clientX: cx, clientY: cy });
        if (at === null) return;
        event.preventDefault();
        place(boxAtClick(at, page));
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      const delta =
        event.key === 'ArrowLeft'
          ? { x: -step, y: 0 }
          : event.key === 'ArrowRight'
            ? { x: step, y: 0 }
            : event.key === 'ArrowUp'
              ? { x: 0, y: -step }
              : event.key === 'ArrowDown'
                ? { x: 0, y: step }
                : null;
      if (delta === null || box === null || !mine) return;
      event.preventDefault();
      // The arrows move on the screen: the delta goes through the view rotation into page space.
      const origin = viewToPage({ x: 0, y: 0 }, page, rotation);
      const moved = viewToPage(delta, page, rotation);
      useCertSign.getState().setBox({ ...box, rect: nudge(box.rect, moved.x - origin.x, moved.y - origin.y, page) });
    };
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKey.current(event);
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const overlay = overlayBox(viewW * transform.pxPerPt, viewH * transform.pxPerPt, page, transform.pxPerPt, rotation);
  const shown: Rect | null = drag !== null ? boxFromDrag(drag.from, drag.to, page) : mine ? box.rect : null;
  const name = identities.find((entry) => entry.id === certId)?.subject.commonName ?? '';
  const date = useMemo(() => sealDate(new Date()), []);
  return (
    <div
      ref={surface}
      data-cert-placement-layer=""
      style={{ zIndex: 'var(--z-canvas-annotations)' }}
      className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDrag(null);
        setResizing(null);
      }}
    >
      <svg
        className="pointer-events-none absolute overflow-visible"
        width={overlay.width}
        height={overlay.height}
        viewBox={`0 0 ${page[0]} ${page[1]}`}
        style={{ left: overlay.left, top: overlay.top, transform: overlay.transform, transformOrigin: 'center' }}
      >
        {shown !== null && (
          <g data-seal-placeholder="" role="group" aria-label={t('cert.placeholder.aria')}>
            <rect
              x={shown.x}
              y={shown.y}
              width={shown.w}
              height={shown.h}
              rx={4}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth={OUTLINE_PT}
              strokeDasharray={DASH}
            />
            {rotation === 0 && (
              <>
                <text x={shown.x + 8} y={shown.y + 20} fontSize={11} fontWeight={500} fill="var(--color-ink)">
                  {name}
                </text>
                <text x={shown.x + 8} y={shown.y + 32} fontSize={8} fill="var(--color-ink)">
                  {t('seal.signed')}
                </text>
                <text x={shown.x + 8} y={shown.y + 42} fontSize={8} fill="var(--text-secondary)">
                  {date}
                </text>
              </>
            )}
            {mine && drag === null && (
              <g data-seal-handles="">
                {SEAL_HANDLES.map((handle) => {
                  const unit = 1 / transform.pxPerPt;
                  const cx = shown.x + ((handle.hx + 1) * shown.w) / 2;
                  const cy = shown.y + ((handle.hy + 1) * shown.h) / 2;
                  const key = `${handle.hx}:${handle.hy}`;
                  return (
                    <g key={key} data-seal-handle={key}>
                      <rect
                        x={cx - (HANDLE_PX * unit) / 2}
                        y={cy - (HANDLE_PX * unit) / 2}
                        width={HANDLE_PX * unit}
                        height={HANDLE_PX * unit}
                        rx={2 * unit}
                        fill="var(--color-white)"
                        stroke="var(--color-ink)"
                        strokeWidth={unit}
                      />
                      <rect
                        x={cx - (HANDLE_HIT_PX * unit) / 2}
                        y={cy - (HANDLE_HIT_PX * unit) / 2}
                        width={HANDLE_HIT_PX * unit}
                        height={HANDLE_HIT_PX * unit}
                        fill="transparent"
                        style={{
                          pointerEvents: 'all',
                          cursor: handleCursor(handle, rotation === 90 || rotation === 270),
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.stopPropagation();
                          event.preventDefault();
                          (event.target as Element).setPointerCapture?.(event.pointerId);
                          setResizing(handle);
                        }}
                      />
                    </g>
                  );
                })}
              </g>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
