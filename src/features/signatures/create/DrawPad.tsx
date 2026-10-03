import { useRef, useState, type PointerEvent } from 'react';

import { useT } from '../../../i18n';
import { polygonPoints, pushSample, smoothStroke, strokeOutline, type Sample } from '../../annotations/create/ink';
import { INK_CLASS, PAD_SURFACE } from './Previews';
import { PAD_WIDTH_PX, samplePressure, type SigColour } from './model';

/** Where the baseline sits, in percent of the pad height. */
const BASELINE_PCT = 72;

export interface DrawPadProps {
  /** The finished strokes, smoothed. */
  strokes: readonly (readonly Sample[])[];
  onStrokes: (strokes: readonly (readonly Sample[])[]) => void;
  colour: SigColour;
  initials: boolean;
}

/**
 * The ink pad (DESIGN 3.33): pointer strokes with the width following the pressure, drawn as filled outlines. Coordinates are the
 * pad's own pixels, so the outlines go to the backend as they are seen. The pad is an image for screen readers; the Type tab is the
 * alternative for anyone who cannot draw.
 */
export function DrawPad({ strokes, onStrokes, colour, initials }: DrawPadProps) {
  const t = useT();
  const pad = useRef<HTMLDivElement>(null);
  const live = useRef<{ pointerId: number; buffer: Sample[] } | null>(null);
  const [drawing, setDrawing] = useState<readonly Sample[]>([]);

  const sampleOf = (event: PointerEvent<HTMLDivElement>): Sample => {
    const box = pad.current?.getBoundingClientRect();
    return {
      x: event.clientX - (box?.left ?? 0),
      y: event.clientY - (box?.top ?? 0),
      pressure: samplePressure(event.pointerType, event.pressure),
    };
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = live.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    live.current = null;
    if (typeof pad.current?.releasePointerCapture === 'function' && pad.current.hasPointerCapture(event.pointerId)) {
      pad.current.releasePointerCapture(event.pointerId);
    }
    if (current.buffer.length > 0) onStrokes([...strokes, smoothStroke(current.buffer)]);
    setDrawing([]);
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || live.current !== null) return;
    event.preventDefault();
    if (typeof pad.current?.setPointerCapture === 'function') pad.current.setPointerCapture(event.pointerId);
    const buffer: Sample[] = [];
    pushSample(buffer, sampleOf(event));
    live.current = { pointerId: event.pointerId, buffer };
    setDrawing(buffer.slice());
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = live.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    if (pushSample(current.buffer, sampleOf(event))) setDrawing(current.buffer.slice());
  };

  const empty = strokes.length === 0 && drawing.length === 0;

  return (
    <div
      ref={pad}
      role="img"
      aria-label={t('sign.padLabel')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerCancel={finish}
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
        {strokes.map((stroke, index) => (
          <polygon key={index} points={polygonPoints(strokeOutline(stroke, PAD_WIDTH_PX))} fill="currentColor" />
        ))}
        {drawing.length > 0 && (
          <polygon points={polygonPoints(strokeOutline(drawing, PAD_WIDTH_PX))} fill="currentColor" />
        )}
      </svg>
    </div>
  );
}
