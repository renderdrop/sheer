import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageNumberOf } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { fileRotationOf } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import {
  normalizeRotation,
  overlayBox,
  quadBox,
  swapsSides,
  totalRotation,
  unrotatedSize,
  viewToPage,
  type Box,
  type Point,
} from '../viewer/transform';
import { markArea, moveMark, removeMarks, resizeMark } from './actions';
import { HANDLES, MIN_AREA_PT, cornersToBox, moveBox, resizeBox } from './geometry';
import { useRedact, type RedactMark } from './store';

/** A drag in progress: moving an area mark, or resizing it by one handle. Boxes are in page space. */
interface Drag {
  mark: RedactMark;
  handle: (typeof HANDLES)[number] | null;
  start: Point;
  from: Box;
  moved: boolean;
}

const NUDGE_PT = 1;
const NUDGE_BIG_PT = 10;
/** Where a drag of the page may start: not on a text run (that selects text), a mark, a control or a dialog. */
const NOT_A_DRAG_START = '[data-run-start], [data-redact-mark], [data-redact-handle], button, input, [role="dialog"]';

const boxOfMark = (mark: RedactMark): Box => quadBox(mark.quads.flat());

/**
 * The redaction marks of one page, in page space (canvas layer 3, DESIGN 3.38), and while the mode is on the pointer work of the
 * page: a drag on the page outside the text draws an area mark (at least 4 pt), a drag over the text selects it and the host marks
 * the selection when the pointer is released. A selected area mark moves (drag, arrows) and resizes by its 8 handles; a text mark
 * is a box only. Delete removes the selected mark. Marks are drawn when the mode is off too, but then take no input.
 */
export const RedactLayer: FC<PageLayerProps> = memo(function RedactLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  ready,
}) {
  const t = useT();
  const root = useRef<HTMLDivElement | null>(null);
  const modeOn = useUi((state) => state.redactMode && state.activeTool === 'select');
  const activeDocument = useDocuments(selectActiveId) === docId;
  const byId = useRedact((state) => state.marks[docId]);
  const selectedId = useRedact((state) => state.selected[docId] ?? null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [preview, setPreview] = useState<{ id: number; box: Box } | null>(null);
  const drag = useRef<Drag | null>(null);

  const marks = useMemo(
    () =>
      Object.values(byId ?? {})
        .filter((mark) => mark.pageId === pageIndex)
        .sort((a, b) => a.id - b.id),
    [byId, pageIndex],
  );

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = useMemo(() => unrotatedSize([widthPt, heightPt], file), [widthPt, heightPt, file]);
  const total = totalRotation(file, rotation);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;

  // The pointer maps to page space through the page's element: its box is the page as shown, the rotation applied.
  const geometry = useRef({ page, total, pxPerPt, boxWidth, boxHeight });
  useEffect(() => {
    geometry.current = { page, total, pxPerPt, boxWidth, boxHeight };
  });
  const toPage = (clientX: number, clientY: number): Point | null => {
    const element = root.current?.closest<HTMLElement>('[data-page]');
    if (element === null || element === undefined) return null;
    const rect = element.getBoundingClientRect();
    const g = geometry.current;
    if (rect.width <= 0 || rect.height <= 0 || g.pxPerPt <= 0) return null;
    const view = {
      x: ((clientX - rect.left) * g.boxWidth) / rect.width / g.pxPerPt,
      y: ((clientY - rect.top) * g.boxHeight) / rect.height / g.pxPerPt,
    };
    return viewToPage(view, g.page, g.total);
  };

  const active = modeOn && activeDocument && ready;

  // The drag that draws an area mark starts on the page itself or on the text layer's empty space, never on a run.
  useEffect(() => {
    const element = root.current?.closest<HTMLElement>('[data-page]');
    if (!active || element === null || element === undefined) return;
    element.setAttribute('data-redact-active', '');
    let from: Point | null = null;
    let pointer = -1;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest(NOT_A_DRAG_START) !== null) return;
      const plain =
        target === element ||
        target.closest('[data-text-layer]') !== null ||
        target.tagName === 'IMG' ||
        target.tagName === 'CANVAS';
      if (!plain) return;
      const point = toPage(event.clientX, event.clientY);
      if (point === null) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      useRedact.getState().select(docId, null);
      from = point;
      pointer = event.pointerId;
      element.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (from === null || event.pointerId !== pointer) return;
      const point = toPage(event.clientX, event.clientY);
      if (point !== null) setDraft(cornersToBox(from, point, geometry.current.page));
    };
    const finish = (event: PointerEvent, commit: boolean) => {
      if (from === null || event.pointerId !== pointer) return;
      const point = toPage(event.clientX, event.clientY);
      const start = from;
      from = null;
      pointer = -1;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      setDraft(null);
      if (!commit || point === null) return;
      const box = cornersToBox(start, point, geometry.current.page);
      if (box.w >= MIN_AREA_PT && box.h >= MIN_AREA_PT) void markArea(docId, pageIndex, box);
    };
    const onUp = (event: PointerEvent) => finish(event, true);
    const onCancel = (event: PointerEvent) => finish(event, false);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    return () => {
      element.removeAttribute('data-redact-active');
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      setDraft(null);
    };
    // `toPage` only reads refs.
  }, [active, docId, pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // The root stays mounted (it finds the page element); it is empty when there is nothing to draw.
  if (!ready || !activeDocument || (marks.length === 0 && draft === null)) return <div ref={root} hidden />;

  const style = {
    ...overlayBox(boxWidth, boxHeight, page, pxPerPt, total),
    transformOrigin: 'center',
    '--page-scale': pxPerPt,
  } as CSSProperties;
  const boxOf = (mark: RedactMark): Box => (preview?.id === mark.id ? preview.box : boxOfMark(mark));

  const begin = (event: ReactPointerEvent<HTMLElement>, mark: RedactMark, handle: Drag['handle']) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    useRedact.getState().select(docId, mark.id);
    const start = toPage(event.clientX, event.clientY);
    if (mark.source !== 'area' || start === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mark, handle, start, from: boxOfMark(mark), moved: false };
  };
  const track = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    const point = toPage(event.clientX, event.clientY);
    if (current === null || point === null) return;
    const delta = { x: point.x - current.start.x, y: point.y - current.start.y };
    current.moved = current.moved || Math.abs(delta.x) + Math.abs(delta.y) > 1;
    setPreview({
      id: current.mark.id,
      box:
        current.handle === null
          ? moveBox(current.from, delta, page)
          : resizeBox(current.from, current.handle, delta, page),
    });
  };
  const end = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    const result = preview;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!commit || current === null || !current.moved || result === null) return;
    if (current.handle === null) {
      const dx = result.box.x - current.from.x;
      const dy = result.box.y - current.from.y;
      if (dx !== 0 || dy !== 0) void moveMark(docId, current.mark.id, dx, dy);
    } else {
      void resizeMark(docId, current.mark, result.box);
    }
  };

  const onMarkKey = (event: KeyboardEvent<HTMLElement>, mark: RedactMark) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      void removeMarks(docId, [mark.id]);
      return;
    }
    const arrows: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = arrows[event.key];
    if (direction === undefined || mark.source !== 'area') return;
    event.preventDefault();
    const step = event.shiftKey ? NUDGE_BIG_PT : NUDGE_PT;
    // The arrow points on the screen; the mark moves in page space.
    const zero = viewToPage({ x: 0, y: 0 }, page, total);
    const moved = viewToPage({ x: direction[0] * step, y: direction[1] * step }, page, total);
    const current = boxOfMark(mark);
    const limited = moveBox(current, { x: moved.x - zero.x, y: moved.y - zero.y }, page);
    if (limited.x !== current.x || limited.y !== current.y)
      void moveMark(docId, mark.id, limited.x - current.x, limited.y - current.y);
  };

  const pageNumber = pageNumberOf(docId, pageIndex);
  const label = (mark: RedactMark) =>
    `${mark.source === 'area' ? t('redact.area') : t('redact.mark')}, ${t('search.page', { n: pageNumber })}`;
  return (
    <div ref={root} data-redact-layer="" className="pointer-events-none absolute inset-0 z-canvas-annotations">
      <div role="group" aria-label={t('redact.title', { count: marks.length })} className="absolute" style={style}>
        {marks.map((mark) => {
          const b = boxOf(mark);
          const selected = selectedId === mark.id;
          const area = mark.source === 'area';
          return (
            <div
              key={mark.id}
              className={modeOn ? 'pointer-events-auto absolute' : 'absolute'}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            >
              <div
                role="button"
                aria-roledescription={t('redact.mark')}
                aria-label={label(mark)}
                aria-pressed={selected}
                tabIndex={modeOn && selected ? 0 : -1}
                inert={modeOn ? undefined : true}
                className="absolute inset-0 touch-none"
                onPointerDown={(event) => begin(event, mark, null)}
                onPointerMove={track}
                onPointerUp={(event) => end(event, true)}
                onPointerCancel={(event) => end(event, false)}
                onKeyDown={(event) => onMarkKey(event, mark)}
              >
                {area ? (
                  <div
                    data-redact-mark={mark.id}
                    data-selected={selected ? 'true' : undefined}
                    className="absolute inset-0"
                  />
                ) : (
                  // A text mark: one hatched box per line fragment, inside the box of all of them.
                  mark.quads.map((quad, i) => {
                    const q = quadBox(quad);
                    return (
                      <div
                        // The quads of a mark never change (a mark is replaced, not edited): the index is a stable key.
                        key={i}
                        data-redact-mark={mark.id}
                        data-selected={selected ? 'true' : undefined}
                        className="absolute"
                        style={{ left: q.x - b.x, top: q.y - b.y, width: q.w, height: q.h }}
                      />
                    );
                  })
                )}
              </div>
              {modeOn &&
                selected &&
                area &&
                HANDLES.map((handle) => (
                  <div
                    key={handle.name}
                    data-redact-handle={handle.name}
                    className="absolute -translate-x-1/2 -translate-y-1/2 touch-none"
                    style={{
                      left: handle.dx < 0 ? 0 : handle.dx > 0 ? '100%' : '50%',
                      top: handle.dy < 0 ? 0 : handle.dy > 0 ? '100%' : '50%',
                    }}
                    onPointerDown={(event) => begin(event, mark, handle)}
                    onPointerMove={track}
                    onPointerUp={(event) => end(event, true)}
                    onPointerCancel={(event) => end(event, false)}
                  />
                ))}
            </div>
          );
        })}
        {draft !== null && (
          <div
            data-redact-draft=""
            aria-hidden="true"
            className="absolute"
            style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h }}
          />
        )}
      </div>
    </div>
  );
});
