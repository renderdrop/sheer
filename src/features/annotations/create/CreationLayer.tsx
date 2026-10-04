import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { Annotation, AnnotationDraft, Rgb } from '../../../api/annotations';
import type { Point, Quad, Rect } from '../../../api/wire';
import { useAnnotations } from '../../../stores/annotations';
import { useSettings } from '../../../stores/settings';
import { creationKind, useTools, type CreationKind } from '../../../stores/tools';
import { useUi } from '../../../stores/ui';
import { rgbToCss } from '../../inspector/palette';
import { useAnnotationStyle } from '../../inspector/style';
import { loadLayer, peekLayer } from '../../textlayer/cache';
import { overlayBox, swapsSides, viewToPage, normalizeRotation } from '../../viewer/transform';
import {
  defaultStyle,
  freeTextDraft,
  inkDraft,
  markupDraft,
  noteDraft,
  shapeDraft,
  shapeEnd,
  type CreationStyle,
} from './drafts';
import { reportRefusal } from './refusal';
import { boxFromPoints, clampToPage, isDrag } from './geometry';
import {
  INK_JOIN_MS,
  MAX_ANNOTATION_POINTS,
  polygonPoints,
  pushSample,
  joinsGroup,
  smoothStroke,
  strokeOutline,
  type Sample,
} from './ink';
import { buildTextIndex, quadsForDragIndexed, type TextIndex } from './markup';
import { MAX_INK_STROKES } from '../../../api/annotations';

export interface CreationLayerProps {
  docId: number;
  /** Zero-based; it is also the page id of the model while pages cannot change (M2). */
  pageIndex: number;
  /** The page in page space: points, before the file's `/Rotate`. */
  pageBox: { width: number; height: number };
  /** Scale (px per point) and the rotation that is applied to page space in total (file `/Rotate` and view). */
  transform: { pxPerPt: number; rotation: number };
  /** Called with the annotation after the backend created it (free text: select it and hand focus to the editor). */
  onCreated?: (annotation: Annotation) => void;
}

type Preview =
  | {
      type: 'quads';
      kind: 'highlight' | 'underline' | 'strikeout';
      quads: readonly Quad[];
      color: Rgb;
      opacity: number;
    }
  | { type: 'box'; shape: 'rect' | 'ellipse' | 'freeText'; box: Rect; color: Rgb; width: number }
  | { type: 'line'; from: Point; to: Point; arrow: boolean; color: Rgb; width: number }
  | { type: 'ink'; finished: readonly string[]; current: readonly Sample[]; width: number; color: Rgb };

interface Drag {
  pointerId: number;
  start: Point;
  last: Point;
  moved: boolean;
  /** The raw samples of the stroke being drawn; owned by the drag and appended to in place. */
  samples: Sample[];
  /** The text of the page, indexed once for a markup drag. */
  index: TextIndex | null;
}

const cssOf = rgbToCss;

/** The dash of the outline of a free text box being dragged, in points. */
const BOX_DASH = '4 3';
/** The arrow head of the preview: at least this long, or this many line widths, in points; and its half angle in radians. */
const ARROW_MIN_PT = 6;
const ARROW_WIDTHS = 4;
const ARROW_HALF_ANGLE = 0.45;
/** The underline of the preview sits this far above the bottom of the line; both preview lines are this thick, in points. */
const UNDERLINE_INSET_PT = 0.5;
const MARKUP_LINE_PT = 1;
/** The free text box outline in the preview is this thick, in points. */
const BOX_OUTLINE_PT = 1;

/** The draft with the current author name (ADR-034); an empty name adds none, so no /T is written. */
function withAuthor(draft: AnnotationDraft): AnnotationDraft {
  const author = useSettings.getState().authorName;
  return author === '' ? draft : { ...draft, author };
}

/**
 * The layer that makes annotations on one page for the active tool (DESIGN 3.22). It takes the pointer only while a creation
 * tool is active; every creation is one `createAnnotation` command, so one undo step. Esc cancels the drag in progress.
 */
export function CreationLayer(props: CreationLayerProps) {
  const activeTool = useUi((s) => s.activeTool);
  const markup = useTools((s) => s.markup);
  const shapes = useTools((s) => s.shapes);
  const kind = creationKind(activeTool, { markup, shapes });
  if (kind === null) return null;
  return <ActiveLayer key={kind} kind={kind} {...props} />;
}

function ActiveLayer({
  kind,
  docId,
  pageIndex,
  pageBox,
  transform,
  onCreated,
}: CreationLayerProps & { kind: CreationKind }) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /** Finished smoothed strokes waiting to become one annotation, and their outlines as polygons (cached, never recomputed). */
  const pending = useRef<Sample[][]>([]);
  const finished = useRef<readonly string[]>([]);
  const lastInkEnd = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const nextPreview = useRef<(() => Preview | null) | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const chosen = useAnnotationStyle(kind);
  const style: CreationStyle = useMemo(() => ({ ...defaultStyle(kind), ...chosen }), [kind, chosen]);

  const rotation = normalizeRotation(transform.rotation);
  const page = useMemo(() => [pageBox.width, pageBox.height] as const, [pageBox.width, pageBox.height]);
  const viewW = swapsSides(rotation) ? page[1] : page[0];
  const viewH = swapsSides(rotation) ? page[0] : page[1];

  /** Shows the preview that `make` builds, at most once per animation frame (the last request of the frame wins). */
  const schedule = useCallback((make: () => Preview | null) => {
    nextPreview.current = make;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const build = nextPreview.current;
      nextPreview.current = null;
      if (build !== null) setPreview(build());
    });
  }, []);

  /** Drops a preview that is waiting for its frame, and shows `now` at once. */
  const show = useCallback((now: Preview | null) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    nextPreview.current = null;
    setPreview(now);
  }, []);

  const toPage = useCallback(
    (event: { clientX: number; clientY: number }): Point | null => {
      const element = surface.current;
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const view = {
        x: ((event.clientX - rect.left) / rect.width) * viewW,
        y: ((event.clientY - rect.top) / rect.height) * viewH,
      };
      return clampToPage(viewToPage(view, page, rotation), page[0], page[1]);
    },
    [page, rotation, viewW, viewH],
  );

  const commit = useCallback(
    (draft: AnnotationDraft | null) => {
      if (draft === null) return;
      useAnnotations
        .getState()
        .apply(docId, { type: 'createAnnotation', draft: withAuthor(draft) })
        .then((changes) => {
          const created = changes.upserted[0];
          if (created !== undefined) onCreated?.(created);
        })
        .catch(reportRefusal);
      if (!useUi.getState().toolLocked) useUi.getState().releaseTool();
    },
    [docId, onCreated],
  );

  const flushInk = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const strokes = pending.current;
    pending.current = [];
    finished.current = [];
    lastInkEnd.current = null;
    show(null);
    commit(inkDraft(pageIndex, strokes, style));
  }, [commit, pageIndex, style, show]);

  // Leaving the tool (or the page) with strokes waiting makes them the annotation they were going to be.
  const flushRef = useRef(flushInk);
  useEffect(() => {
    flushRef.current = flushInk;
  });
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (pending.current.length > 0) flushRef.current();
    },
    [],
  );

  useEffect(() => {
    if (kind === 'highlight' || kind === 'underline' || kind === 'strikeout') void loadLayer(docId, pageIndex);
  }, [kind, docId, pageIndex]);

  const cancel = useCallback(() => {
    drag.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = [];
    finished.current = [];
    lastInkEnd.current = null;
    show(null);
  }, [show]);

  // Esc cancels what is being made, and is not passed on (it would also leave the tool).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (drag.current === null && pending.current.length === 0)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [cancel]);

  const isMarkup = kind === 'highlight' || kind === 'underline' || kind === 'strikeout';

  const showInk = useCallback(
    (current: readonly Sample[]) => {
      const polygons = finished.current;
      schedule(() => ({
        type: 'ink',
        finished: polygons,
        // Copied when the frame is built (once per frame), not once per pointer event.
        current: current.slice(),
        width: style.width,
        color: style.color,
      }));
    },
    [schedule, style.width, style.color],
  );

  /** A stroke is over (pointer up, or cancelled): it joins the group, which is committed 1000 ms after its last stroke. */
  const endStroke = useCallback(
    (samples: readonly Sample[], at: number) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (samples.length > 0) {
        const stroke = smoothStroke(samples);
        pending.current.push(stroke);
        finished.current = [...finished.current, polygonPoints(strokeOutline(stroke, style.width))];
        lastInkEnd.current = at;
      }
      if (pending.current.length > 0) {
        const polygons = finished.current;
        show({
          type: 'ink',
          finished: polygons,
          current: [],
          width: style.width,
          color: style.color,
        });
        timer.current = setTimeout(flushInk, INK_JOIN_MS);
      } else {
        show(null);
      }
    },
    [flushInk, show, style.width, style.color],
  );

  const releaseCapture = (pointerId: number) => {
    const element = surface.current;
    if (
      element !== null &&
      typeof element.releasePointerCapture === 'function' &&
      element.hasPointerCapture(pointerId)
    ) {
      element.releasePointerCapture(pointerId);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current !== null) return;
    const point = toPage(event);
    if (point === null) return;
    const layer = isMarkup ? peekLayer(docId, pageIndex) : undefined;
    if (isMarkup && layer === undefined) return;
    event.preventDefault();
    const element = surface.current;
    if (element !== null && typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId);
    const samples: Sample[] = [];
    if (kind === 'ink') {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      const total = pending.current.reduce((n, s) => n + s.length, 0);
      const joins = joinsGroup(lastInkEnd.current, event.timeStamp);
      if (
        pending.current.length > 0 &&
        (!joins || total >= MAX_ANNOTATION_POINTS || pending.current.length >= MAX_INK_STROKES)
      ) {
        flushInk();
      }
      samples.push({ ...point, pressure: pressureOf(event.pressure) });
    }
    drag.current = {
      pointerId: event.pointerId,
      start: point,
      last: point,
      moved: false,
      samples,
      index: layer === undefined ? null : buildTextIndex(layer),
    };
    if (kind === 'ink') showInk(samples);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    if (kind === 'ink') {
      const native = event.nativeEvent;
      const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      for (const e of events.length > 0 ? events : [native]) {
        const p = toPage(e);
        if (p !== null) pushSample(d.samples, { ...p, pressure: pressureOf(e.pressure) });
      }
      d.moved = true;
      showInk(d.samples);
      return;
    }
    const point = toPage(event);
    if (point === null) return;
    d.last = point;
    if (!d.moved && !isDrag(d.start, point)) return;
    d.moved = true;
    const { start, index } = d;
    const shift = event.shiftKey;
    schedule(() => previewOf(kind, start, point, shift, style, page, index));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    drag.current = null;
    releaseCapture(event.pointerId);
    if (kind === 'ink') {
      endStroke(d.samples, event.timeStamp);
      return;
    }
    const end = toPage(event) ?? d.last;
    const dragged = d.moved || isDrag(d.start, end);
    show(null);
    switch (kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        if (!dragged || d.index === null) return;
        commit(markupDraft(kind, pageIndex, quadsForDragIndexed(d.index, d.start, end), style));
        return;
      case 'note':
        commit(noteDraft(pageIndex, d.start, page, style));
        return;
      case 'freeText':
        commit(freeTextDraft(pageIndex, d.start, dragged ? end : null, page, style));
        return;
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'arrow':
        if (!dragged) return;
        commit(shapeDraft(kind, pageIndex, d.start, shapeEnd(kind, d.start, end, event.shiftKey, page), page, style));
        return;
      default:
        return;
    }
  };

  // The pointer was taken away (a palm, a system gesture): a stroke so far is finished as it is, a shape is dropped, and the join
  // timer runs again so that a waiting group is committed (never left hanging).
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    drag.current = null;
    releaseCapture(event.pointerId);
    if (kind === 'ink') endStroke(d.samples.length > 1 ? d.samples : [], event.timeStamp);
    else show(null);
  };
  const box = overlayBox(viewW, viewH, page, transform.pxPerPt, rotation);
  return (
    <div
      ref={surface}
      data-creation-layer=""
      data-tool={kind}
      style={{ zIndex: 'var(--z-canvas-annotations)' }}
      className={`pointer-events-auto absolute inset-0 touch-none select-none ${isMarkup ? 'cursor-text' : 'cursor-crosshair'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute overflow-visible"
        width={box.width}
        height={box.height}
        viewBox={`0 0 ${page[0]} ${page[1]}`}
        style={{ left: box.left, top: box.top, transform: box.transform, transformOrigin: 'center' }}
      >
        {preview === null ? null : <PreviewShape preview={preview} />}
      </svg>
    </div>
  );
}

function pressureOf(pressure: number): number {
  return Number.isFinite(pressure) && pressure > 0 ? Math.min(pressure, 1) : 0.5;
}

function previewOf(
  kind: CreationKind,
  start: Point,
  point: Point,
  shift: boolean,
  style: CreationStyle,
  page: readonly [number, number],
  index: TextIndex | null,
): Preview | null {
  switch (kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return index === null
        ? null
        : {
            type: 'quads',
            kind,
            quads: quadsForDragIndexed(index, start, point),
            color: style.color,
            opacity: style.opacity,
          };
    case 'freeText':
      return {
        type: 'box',
        shape: 'freeText',
        box: boxFromPoints(start, point),
        color: style.color,
        width: BOX_OUTLINE_PT,
      };
    case 'rect':
    case 'ellipse': {
      const draft = shapeDraft(kind, 0, start, shapeEnd(kind, start, point, shift, page), page, style);
      return draft.kind === 'rect' || draft.kind === 'ellipse'
        ? { type: 'box', shape: draft.kind, box: draft.box, color: style.color, width: style.width }
        : null;
    }
    case 'line':
    case 'arrow': {
      const to = clampToPage(shapeEnd(kind, start, point, shift, page), page[0], page[1]);
      return { type: 'line', from: start, to, arrow: kind === 'arrow', color: style.color, width: style.width };
    }
    default:
      return null;
  }
}

function PreviewShape({ preview }: { preview: Preview }) {
  switch (preview.type) {
    case 'quads':
      return (
        <g style={{ mixBlendMode: preview.kind === 'highlight' ? 'multiply' : 'normal' }}>
          {preview.quads.map((q, i) => {
            const [tl, , , br] = q;
            const key = `${i}:${tl.x}:${tl.y}`;
            if (preview.kind === 'highlight') {
              return (
                <rect
                  key={key}
                  x={tl.x}
                  y={tl.y}
                  width={br.x - tl.x}
                  height={br.y - tl.y}
                  fill={cssOf(preview.color)}
                  fillOpacity={preview.opacity}
                />
              );
            }
            const y = preview.kind === 'underline' ? br.y - UNDERLINE_INSET_PT : (tl.y + br.y) / 2;
            return (
              <line
                key={key}
                x1={tl.x}
                x2={br.x}
                y1={y}
                y2={y}
                stroke={cssOf(preview.color)}
                strokeWidth={MARKUP_LINE_PT}
              />
            );
          })}
        </g>
      );
    case 'box': {
      const common = {
        fill: 'none',
        stroke: preview.shape === 'freeText' ? 'var(--color-doc-select)' : cssOf(preview.color),
        strokeWidth: preview.width,
        strokeDasharray: preview.shape === 'freeText' ? BOX_DASH : undefined,
      };
      const { x, y, w, h } = preview.box;
      return preview.shape === 'ellipse' ? (
        <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
      ) : (
        <rect x={x} y={y} width={w} height={h} {...common} />
      );
    }
    case 'line': {
      const { from, to, width } = preview;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const size = Math.max(ARROW_MIN_PT, width * ARROW_WIDTHS);
      const wing = (a: number) => `${to.x - Math.cos(angle + a) * size},${to.y - Math.sin(angle + a) * size}`;
      return (
        <g stroke={cssOf(preview.color)} strokeWidth={width} strokeLinecap="round" fill="none">
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
          {preview.arrow ? (
            <polygon
              points={`${to.x},${to.y} ${wing(ARROW_HALF_ANGLE)} ${wing(-ARROW_HALF_ANGLE)}`}
              fill={cssOf(preview.color)}
            />
          ) : null}
        </g>
      );
    }
    case 'ink':
      return (
        <g fill={cssOf(preview.color)}>
          {preview.finished.map((points, i) => (
            <polygon key={i} points={points} />
          ))}
          {preview.current.length > 0 ? (
            <polygon points={polygonPoints(strokeOutline(preview.current, preview.width))} />
          ) : null}
        </g>
      );
    default:
      return null;
  }
}
