import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { announce } from '../../../components';
import { useT } from '../../../i18n';
import type { Point } from '../../../api/wire';
import { useUi } from '../../../stores/ui';
import { clampToPage } from '../../annotations/create/geometry';
import { overlayBox, swapsSides, viewToPage, normalizeRotation } from '../../viewer/transform';
import { centredBox, dateText, itemSize } from './drafts';
import { placeItem } from './place';
import { MarkGlyphShape } from './SignatureShape';
import { usePlacement, type PlaceItem } from './store';

export interface PlacementLayerProps {
  docId: number;
  /** Zero-based; it is also the page id of the model while pages cannot change. */
  pageIndex: number;
  /** The page in page space: points, before the file's `/Rotate`. */
  pageBox: { width: number; height: number };
  /** Scale (px per point) and the rotation that is applied to page space in total. */
  transform: { pxPerPt: number; rotation: number };
}

/** The ghost is shown at this opacity (DESIGN 3.34). */
const GHOST_OPACITY = 0.5;
/** The outline of a ghost that is not a mark, in points. */
const GHOST_OUTLINE_PT = 1;
const GHOST_DASH = '4 3';

/**
 * The layer that places the armed item of the Sign tool on one page (DESIGN 3.34). It takes the pointer only while the tool is
 * active and an item is armed. A ghost at the default size follows the pointer; a click places the item centred on it. Esc
 * disarms and leaves the tool.
 */
export function PlacementLayer(props: PlacementLayerProps) {
  const active = useUi((s) => s.activeTool === 'signature');
  const item = usePlacement((s) => s.item);
  if (!active || item === null) return null;
  return <ActiveLayer item={item} {...props} />;
}

function ActiveLayer({ item, docId, pageIndex, pageBox, transform }: PlacementLayerProps & { item: PlaceItem }) {
  const t = useT();
  const surface = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<Point | null>(null);
  const rotation = normalizeRotation(transform.rotation);
  const page = useMemo(() => [pageBox.width, pageBox.height] as const, [pageBox.width, pageBox.height]);
  const viewW = swapsSides(rotation) ? page[1] : page[0];
  const viewH = swapsSides(rotation) ? page[0] : page[1];

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

  // Esc disarms and leaves the tool; the window sees it even when focus is on the canvas.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      usePlacement.getState().disarm();
      useUi.getState().releaseTool();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => setGhost(toPage(event));

  const placeAt = (at: Point) => {
    if (!useUi.getState().toolLocked) {
      // One-shot: the tool is done with this click, whatever the backend answers.
      usePlacement.getState().disarm();
      useUi.getState().releaseTool();
    }
    setGhost(null);
    void placeItem(docId, pageIndex, item, at, page).then((created) => {
      if (created !== null) announce(t('sign.placed', { kind: t(`annot.type.${created.kind}`), n: pageIndex + 1 }));
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = toPage(event);
    if (at === null) return;
    event.preventDefault();
    placeAt(at);
  };

  // Enter places at the centre of the viewport, on the page that is there (DESIGN 3.34; the keyboard's way to place).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, button, [role^="menu"]') !== null)
        return;
      const element = surface.current;
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return;
      const at = toPage({ clientX: cx, clientY: cy });
      if (at === null) return;
      event.preventDefault();
      placeAt(at);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const box = overlayBox(viewW, viewH, page, transform.pxPerPt, rotation);
  const ghostBox =
    ghost === null ? null : centredBox(ghost, itemSize(item, page, item.type === 'date' ? dateText() : ''), page);
  return (
    <div
      ref={surface}
      data-placement-layer=""
      data-item={item.type}
      style={{ zIndex: 'var(--z-canvas-annotations)' }}
      className="absolute inset-0 cursor-copy touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setGhost(null)}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute overflow-visible"
        width={box.width}
        height={box.height}
        viewBox={`0 0 ${page[0]} ${page[1]}`}
        style={{ left: box.left, top: box.top, transform: box.transform, transformOrigin: 'center' }}
      >
        {ghostBox === null ? null : item.type === 'mark' ? (
          <MarkGlyphShape glyph={item.glyph} box={ghostBox} color="var(--color-doc-select)" opacity={GHOST_OPACITY} />
        ) : (
          <rect
            data-placement-ghost=""
            x={ghostBox.x}
            y={ghostBox.y}
            width={ghostBox.w}
            height={ghostBox.h}
            fill="none"
            stroke="var(--color-doc-select)"
            strokeWidth={GHOST_OUTLINE_PT}
            strokeDasharray={GHOST_DASH}
            opacity={GHOST_OPACITY}
          />
        )}
      </svg>
    </div>
  );
}
