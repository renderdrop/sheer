import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { Annotation, AnnotationDraft, LineEnd, Rgb } from '../../../api/annotations';
import type { Point, Quad, Rect } from '../../../api/wire';
import { useAnnotations } from '../../../stores/annotations';
import { useSettings } from '../../../stores/settings';
import { creationKind, useTools, type CreationKind } from '../../../stores/tools';
import { useUi } from '../../../stores/ui';
import { rgbToCss } from '../../inspector/palette';
import { useAnnotationStyle } from '../../inspector/style';
import { loadLayer, peekLayer } from '../../textlayer/cache';
import { EndHead } from '../layer/shapes';
import { overlayBox, swapsSides, viewToPage, normalizeRotation } from '../../viewer/transform';
import {
  defaultStyle,
  freeTextDraft,
  inkDraft,
  markupDraft,
  noteDraft,
  recognisedDraft,
  shapeDraft,
  shapeEnd,
  type CreationStyle,
} from './drafts';
import { reportRefusal } from './refusal';
import { textStyleOf } from './textStyle';
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
import { HOLD_STILL_PX, holdShapeMs, recognise, snapFor, snapTo, type Recognised, type Snap } from './recognise';
import { MAX_INK_STROKES } from '../../../api/annotations';
import { prefersReducedMotion, tokenMs, tokenNumber } from '../../thumbnails/motion';

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
  /** A press on a movable annotation moves it instead of making a new one: true if it took the press (ADR-105). */
  grab?: (event: ReactPointerEvent, at: Point) => boolean;
}

type Preview =
  | {
      type: 'quads';
      kind: 'highlight' | 'underline' | 'strikeout';
      quads: readonly Quad[];
      color: Rgb;
      opacity: number;
      /** Spell 5: the pointer is released; the strip dries (opacity pulse) until the real highlight replaces it. */
      dry?: 'pulse' | 'still';
    }
  | { type: 'box'; shape: 'rect' | 'ellipse' | 'freeText'; box: Rect; color: Rgb; width: number }
  | { type: 'line'; from: Point; to: Point; head: LineEnd; tail: LineEnd; color: Rgb; width: number }
  /** `snap`: the shape the stroke was recognised as; the stroke fades out and the shape fades in (MOTION spell 20). */
  | {
      type: 'ink';
      finished: readonly string[];
      current: readonly Sample[];
      width: number;
      color: Rgb;
      snap?: Extract<Preview, { type: 'box' | 'line' }>;
    };

interface Drag {
  pointerId: number;
  start: Point;
  last: Point;
  moved: boolean;
  /** The raw samples of the stroke being drawn; owned by the drag and appended to in place. */
  samples: Sample[];
  /** The text of the page, indexed once for a markup drag. */
  index: TextIndex | null;
  /** Ink: where the pointer is held still from (client px) and, once the stroke was recognised, the shape it became (B11). */
  hold: { x: number; y: number };
  snap: { snap: Snap; at: Point } | null;
  /** Esc took the snap back: this stroke stays ink. */
  noSnap: boolean;
}

const cssOf = rgbToCss;

/** Spell 5: the dry pulse's peak over its rest alpha, read from `--marker-peak` over `--marker-rest` (the spec values without a stylesheet). */
const markerPeakRatio = (): number => tokenNumber('--marker-peak', 0.55) / tokenNumber('--marker-rest', 0.45);

/** The dash of the outline of a free text box being dragged, in points. */
const BOX_DASH = '4 3';
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
  grab,
}: CreationLayerProps & { kind: CreationKind }) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /** Finished smoothed strokes waiting to become one annotation, and their outlines as polygons (cached, never recomputed). */
  const pending = useRef<Sample[][]>([]);
  const finished = useRef<readonly string[]>([]);
  const lastInkEnd = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pen held still on a stroke: after the hold time it may snap to a shape (DESIGN 3.5 B11). */
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  /** Spell 5: how long the dried strip stays under the real highlight. */
  const dryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextPreview = useRef<(() => Preview | null) | null>(null);
  const showInkRef = useRef<(current: readonly Sample[]) => void>(() => undefined);
  const [preview, setPreview] = useState<Preview | null>(null);
  const recogniseShapes = useTools((state) => state.recogniseShapes);
  const chosen = useAnnotationStyle(kind);
  const textDefaults = useTools((state) => state.defaults.freeText);
  const style: CreationStyle = useMemo(
    () => ({ ...defaultStyle(kind), ...chosen, ...(kind === 'freeText' ? textStyleOf(textDefaults) : {}) }),
    [kind, chosen, textDefaults],
  );

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

  /** The dry pulse is over: the strip goes (the real highlight is already there). */
  const endDry = useCallback(() => {
    if (dryTimer.current !== null) clearTimeout(dryTimer.current);
    dryTimer.current = null;
    setPreview(null);
  }, []);

  /** Drops a preview that is waiting for its frame, and shows `now` at once. */
  const show = useCallback((now: Preview | null) => {
    if (dryTimer.current !== null) clearTimeout(dryTimer.current);
    dryTimer.current = null;
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

  /**
   * A stroke that snapped to a shape: first the stroke as ink, then one command that swaps it for the shape. Undo of that command gives
   * the stroke back (DESIGN 3.5 B11). If the ink is refused or comes back without an id, the shape alone is made.
   */
  const commitSnap = useCallback(
    (samples: readonly Sample[], shape: Recognised) => {
      const snapped = withAuthor(recognisedDraft(shape, pageIndex, page, style));
      const ink = inkDraft(pageIndex, [smoothStroke(samples)], style);
      const state = useAnnotations.getState();
      const shapeOnly = () => state.apply(docId, { type: 'createAnnotation', draft: snapped }).catch(reportRefusal);
      if (ink === null) {
        void shapeOnly();
        return;
      }
      state
        .apply(docId, { type: 'createAnnotation', draft: withAuthor(ink) })
        .then((changes) => {
          const id = changes.upserted[0]?.id;
          if (id === undefined) return shapeOnly();
          return useAnnotations
            .getState()
            .apply(docId, {
              type: 'batch',
              label: 'annotation.create',
              commands: [
                { type: 'deleteAnnotations', ids: [id] },
                { type: 'createAnnotation', draft: snapped },
              ],
            })
            .catch(reportRefusal);
        })
        .catch(reportRefusal);
    },
    [docId, page, pageIndex, style],
  );

  // Leaving the tool (or the page) with strokes waiting makes them the annotation they were going to be.
  const flushRef = useRef(flushInk);
  useEffect(() => {
    flushRef.current = flushInk;
  });
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (holdTimer.current !== null) clearTimeout(holdTimer.current);
      if (dryTimer.current !== null) clearTimeout(dryTimer.current);
      if (pending.current.length > 0) flushRef.current();
    },
    [],
  );

  useEffect(() => {
    if (kind === 'highlight' || kind === 'underline' || kind === 'strikeout') void loadLayer(docId, pageIndex);
  }, [kind, docId, pageIndex]);

  const cancel = useCallback(() => {
    drag.current = null;
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
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
      // A snapped stroke goes back to being the stroke it was (and does not snap again); anything else is dropped.
      const d = drag.current;
      if (d !== null && d.snap !== null) {
        d.snap = null;
        d.noSnap = true;
        if (holdTimer.current !== null) clearTimeout(holdTimer.current);
        holdTimer.current = null;
        showInkRef.current(d.samples);
        return;
      }
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
  useEffect(() => {
    showInkRef.current = showInk;
  });

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);

  /** The pen has been held still for the hold time: a stroke that is clearly a shape becomes it, as a preview until release. */
  const onHold = useCallback(() => {
    holdTimer.current = null;
    const d = drag.current;
    if (d === null || d.snap !== null || d.noSnap || kind !== 'ink' || !useTools.getState().recogniseShapes) return;
    const shape = recognise(d.samples);
    if (shape === null) return;
    // What was drawn before this stroke is its own annotation: it is not part of the shape.
    if (pending.current.length > 0) flushInk();
    const snap = snapFor(shape, d.last);
    d.snap = { snap, at: d.last };
    const draft = recognisedDraft(snap.shape, pageIndex, page, style);
    const snapped = previewOfDraft(draft, style);
    show({
      type: 'ink',
      finished: [],
      current: d.samples.slice(),
      width: style.width,
      color: style.color,
      ...(snapped === null ? {} : { snap: snapped }),
    });
  }, [kind, flushInk, pageIndex, page, style, show]);

  const startHold = useCallback(() => {
    clearHold();
    if (recogniseShapes) holdTimer.current = setTimeout(onHold, holdShapeMs());
  }, [clearHold, recogniseShapes, onHold]);

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
    if (grab?.(event, point) === true) return;
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
      hold: { x: event.clientX, y: event.clientY },
      snap: null,
      noSnap: false,
    };
    if (kind === 'ink') {
      showInk(samples);
      startHold();
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    if (kind === 'ink' && d.snap !== null) {
      // After the snap the pointer resizes the shape: its end point, or the corner that is nearest it.
      const point = toPage(event);
      if (point === null) return;
      d.last = point;
      const { snap, at } = d.snap;
      const shape = snapTo(snap, at, point);
      schedule(() => {
        const snapped = previewOfDraft(recognisedDraft(shape, pageIndex, page, style), style);
        return {
          type: 'ink',
          finished: [],
          current: d.samples.slice(),
          width: style.width,
          color: style.color,
          ...(snapped === null ? {} : { snap: snapped }),
        };
      });
      return;
    }
    if (kind === 'ink') {
      const native = event.nativeEvent;
      const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      for (const e of events.length > 0 ? events : [native]) {
        const p = toPage(e);
        if (p !== null) pushSample(d.samples, { ...p, pressure: pressureOf(e.pressure) });
      }
      d.moved = true;
      const last = d.samples[d.samples.length - 1];
      if (last !== undefined) d.last = last;
      showInk(d.samples);
      // Held still: within a few px of where it came to rest. Moving farther starts the hold again.
      if (Math.hypot(event.clientX - d.hold.x, event.clientY - d.hold.y) > HOLD_STILL_PX) {
        d.hold = { x: event.clientX, y: event.clientY };
        startHold();
      }
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
    clearHold();
    if (kind === 'ink' && d.snap !== null) {
      // The stroke became a shape: release makes it the real annotation (the stroke is ink first, so one undo gives it back).
      const point = toPage(event) ?? d.last;
      show(null);
      commitSnap(d.samples, snapTo(d.snap.snap, d.snap.at, point));
      return;
    }
    if (kind === 'ink') {
      endStroke(d.samples, event.timeStamp);
      return;
    }
    const end = toPage(event) ?? d.last;
    const dragged = d.moved || isDrag(d.start, end);
    show(null);
    if (kind === 'highlight' && dragged && d.index !== null) {
      // The strip stays for one dry pulse (MOTION spell 5) while the real highlight is made, then goes.
      const quads = quadsForDragIndexed(d.index, d.start, end);
      const pulse = !prefersReducedMotion();
      setPreview({
        type: 'quads',
        kind: 'highlight',
        quads,
        color: style.color,
        opacity: pulse ? Math.min(1, style.opacity * markerPeakRatio()) : style.opacity,
        dry: pulse ? 'pulse' : 'still',
      });
      dryTimer.current = setTimeout(
        () => {
          dryTimer.current = null;
          setPreview(null);
        },
        // The dry pulse ends the strip (animationend); this is the fallback should that event not come.
        tokenMs('--motion-fast', 120) * 3,
      );
    }
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
    clearHold();
    if (kind === 'ink' && d.snap !== null) show(null);
    else if (kind === 'ink') endStroke(d.samples.length > 1 ? d.samples : [], event.timeStamp);
    else show(null);
  };
  const box = overlayBox(viewW * transform.pxPerPt, viewH * transform.pxPerPt, page, transform.pxPerPt, rotation);
  return (
    <div
      ref={surface}
      data-creation-layer=""
      data-tool={kind}
      style={{ zIndex: 'var(--z-canvas-annotations)' }}
      className={`pointer-events-auto absolute inset-0 touch-none select-none`}
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
        {preview === null ? null : <PreviewShape preview={preview} onDryEnd={endDry} />}
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
    case 'ellipse':
    case 'line':
    case 'arrow':
      return previewOfDraft(shapeDraft(kind, 0, start, shapeEnd(kind, start, point, shift, page), page, style), style);
    default:
      return null;
  }
}

/** The preview of a shape draft (a rectangle, an ellipse or a line with its ends); `null` for any other draft. */
function previewOfDraft(
  draft: AnnotationDraft,
  style: CreationStyle,
): Extract<Preview, { type: 'box' | 'line' }> | null {
  switch (draft.kind) {
    case 'rect':
    case 'ellipse':
      return { type: 'box', shape: draft.kind, box: draft.box, color: style.color, width: style.width };
    case 'line':
      return {
        type: 'line',
        from: draft.from,
        to: draft.to,
        head: draft.head,
        tail: draft.tail,
        color: style.color,
        width: style.width,
      };
    default:
      return null;
  }
}

function PreviewShape({ preview, onDryEnd }: { preview: Preview; onDryEnd?: () => void }) {
  switch (preview.type) {
    case 'quads':
      return (
        <g
          data-marker-trail={preview.kind === 'highlight' ? '' : undefined}
          data-marker-dry={preview.dry}
          onAnimationEnd={preview.dry === 'pulse' ? onDryEnd : undefined}
          style={{ mixBlendMode: preview.kind === 'highlight' ? 'multiply' : 'normal' }}
        >
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
      const color = cssOf(preview.color);
      return (
        <g>
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={width} strokeLinecap="round" />
          <EndHead at={to} from={from} end={preview.head} width={width} color={color} />
          <EndHead at={from} from={to} end={preview.tail} width={width} color={color} />
        </g>
      );
    }
    case 'ink':
      return (
        <g>
          <g fill={cssOf(preview.color)}>
            {preview.finished.map((points, i) => (
              <polygon key={i} points={points} />
            ))}
            {preview.current.length > 0 ? (
              <polygon
                data-snap-out={preview.snap === undefined ? undefined : ''}
                points={polygonPoints(strokeOutline(preview.current, preview.width))}
              />
            ) : null}
          </g>
          {preview.snap === undefined ? null : (
            <g data-snap-in="">
              <PreviewShape preview={preview.snap} />
            </g>
          )}
        </g>
      );
    default:
      return null;
  }
}
