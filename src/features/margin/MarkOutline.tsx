import { useEffect, type RefObject } from 'react';

import { useTrackedRect } from './useTrackedRect';

/** The one pulse of a hovered bubble's mark lasts this long (the keyframes in tokens.css use the same sum of motion tokens). */
export const PULSE_MS = 400;
/** Reduced motion: no animation, a static outline for this long. */
export const PULSE_STATIC_MS = 600;

export interface MarkOutlineProps {
  /** The element the outline is positioned in (the margin column). */
  origin: RefObject<HTMLElement | null>;
  /** The annotation whose mark is outlined. */
  annotId: number;
  /** `frame`: stays (the comment being written or focused). `pulse`: once, then `onDone`. */
  mode: 'frame' | 'pulse';
  reduced?: boolean;
  onDone?: () => void;
}

/**
 * An outline around the mark of a comment on the page (DESIGN 3.5 B9, F19.24). It replaces the connector line: hovering a bubble
 * pulses its mark once; the comment being written or focused keeps a frame. The position is read from the mark's current box
 * (`useTrackedRect`), never stored, so it follows scroll, zoom, resize and layout shifts.
 */
export function MarkOutline({ origin, annotId, mode, reduced = false, onDone }: MarkOutlineProps) {
  const rect = useTrackedRect(origin, `[data-annot-frame="${annotId}"]`);
  useEffect(() => {
    if (mode !== 'pulse' || onDone === undefined) return;
    const timer = window.setTimeout(onDone, reduced ? PULSE_STATIC_MS : PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [mode, reduced, onDone]);
  if (rect === null) return null;
  return (
    <span
      aria-hidden="true"
      data-mark-outline={annotId}
      data-mode={mode}
      className="pointer-events-none absolute rounded-sm border-2 border-solid border-accent outline-1 outline-solid outline-text"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        // Outside the mark by the focus offset, as the focus ring is.
        margin: 'calc(-1 * var(--focus-offset))',
        padding: 'var(--focus-offset)',
        boxSizing: 'content-box',
      }}
    />
  );
}
