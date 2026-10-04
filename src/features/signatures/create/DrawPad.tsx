import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { useT } from '../../../i18n';
import { inkOutline, pathToD, type InkSample } from '../ink';
import { INK_CLASS, PAD_SURFACE } from './Previews';
import { PAD_WIDTH_PX, samplePressure, type SigColour } from './model';

/** Where the baseline sits, in percent of the pad height. */
const BASELINE_PCT = 72;
/** A stroke keeps at most this many samples (a pad stroke is a few hundred). */
const MAX_SAMPLES = 4000;

export interface DrawPadProps {
  /** The finished strokes, as the pointer reported them. */
  strokes: readonly (readonly InkSample[])[];
  onStrokes: (strokes: readonly (readonly InkSample[])[]) => void;
  colour: SigColour;
  initials: boolean;
}

/**
 * The ink pad (DESIGN 3.33, ADR-051): pointer strokes drawn as filled Bézier outlines, the live stroke with the same `inkOutline`
 * that makes the saved art. Coordinates are the pad's own CSS pixels. The pad is SVG, so it is sharp at every device pixel ratio and
 * needs no backing store to re-scale. It is an image for screen readers; the Type tab is the alternative for anyone who cannot draw.
 */
export function DrawPad({ strokes, onStrokes, colour, initials }: DrawPadProps) {
  const t = useT();
  const pad = useRef<HTMLDivElement>(null);
  const live = useRef<{ pointerId: number; buffer: InkSample[] } | null>(null);
  const livePath = useRef<SVGPathElement>(null);
  const frame = useRef<number | null>(null);
  /** The finished strokes as of the latest write, so two strokes closed before a re-render still both stay. */
  const strokesRef = useRef(strokes);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);
  /** Only whether a stroke is in progress is state; the growing outline is written to the DOM once per frame. */
  const [drawing, setDrawing] = useState(false);

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  useEffect(() => cancelFrame, []);

  const paintLive = (buffer: readonly InkSample[]) => {
    livePath.current?.setAttribute('d', buffer.length > 0 ? pathToD([inkOutline(buffer, PAD_WIDTH_PX)]) : '');
  };

  const sampleOf = (event: {
    clientX: number;
    clientY: number;
    timeStamp: number;
    pointerType: string;
    pressure: number;
  }) => {
    const box = pad.current?.getBoundingClientRect();
    return {
      x: event.clientX - (box?.left ?? 0),
      y: event.clientY - (box?.top ?? 0),
      t: event.timeStamp,
      pressure: samplePressure(event.pointerType, event.pressure),
    } satisfies InkSample;
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = live.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    live.current = null;
    if (typeof pad.current?.releasePointerCapture === 'function' && pad.current.hasPointerCapture(event.pointerId)) {
      pad.current.releasePointerCapture(event.pointerId);
    }
    cancelFrame();
    paintLive([]);
    if (current.buffer.length > 0) {
      strokesRef.current = [...strokesRef.current, current.buffer];
      onStrokes(strokesRef.current);
    }
    setDrawing(false);
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const stale = live.current;
    // A pen-up that never arrived must not glue the next stroke onto the old one: close the old stroke first.
    if (stale !== null) {
      if (stale.pointerId !== event.pointerId) return;
      live.current = null;
      cancelFrame();
      if (stale.buffer.length > 0) {
        strokesRef.current = [...strokesRef.current, stale.buffer];
        onStrokes(strokesRef.current);
      }
    }
    event.preventDefault();
    if (typeof pad.current?.setPointerCapture === 'function') pad.current.setPointerCapture(event.pointerId);
    const buffer: InkSample[] = [sampleOf(event)];
    live.current = { pointerId: event.pointerId, buffer };
    setDrawing(true);
    paintLive(buffer);
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = live.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    // A mouse that moves with no button down has lifted: the stroke is over, hovering is not drawing.
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finish(event);
      return;
    }
    const native = event.nativeEvent;
    const batch = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    for (const item of batch.length > 0 ? batch : [native]) {
      if (current.buffer.length < MAX_SAMPLES) current.buffer.push(sampleOf(item));
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (live.current !== null) paintLive(live.current.buffer);
    });
  };

  const done = useMemo(() => pathToD(strokes.map((stroke) => inkOutline(stroke, PAD_WIDTH_PX))), [strokes]);
  const empty = strokes.length === 0 && !drawing;

  return (
    <div
      ref={pad}
      role="img"
      aria-label={t('sign.padLabel')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      className={`${PAD_SURFACE} h-sig-slot ${initials ? 'w-sig-pad-initials' : 'w-sig-pad'} max-w-full cursor-crosshair touch-none select-none`}
    >
      <span
        aria-hidden="true"
        style={{ top: `${BASELINE_PCT}%` }}
        className="absolute inset-x-2 border-t border-divider"
      />
      {empty && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-text-muted"
        >
          {t('sign.here')}
        </span>
      )}
      <svg aria-hidden="true" className={`absolute inset-0 size-full ${INK_CLASS[colour]}`}>
        <path d={done} fill="currentColor" fillRule="nonzero" />
        <path ref={livePath} fill="currentColor" fillRule="nonzero" />
      </svg>
    </div>
  );
}
