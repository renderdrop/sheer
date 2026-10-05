import { useEffect, useMemo, useState } from 'react';

import type { Rgb } from '../../../api/annotations';
import { rgbToCss } from '../../inspector/palette';
import { prefersReducedMotion, tokenMs } from '../../thumbnails/motion';
import { easeOut, morphAt, shapePoints } from './morph';
import type { Morph } from './recognise';

/**
 * The raw stroke becoming the fitted shape (DESIGN 3.9 Q5): its resampled points glide to the shape's in `--motion-morph` with
 * `--ease-out`, once per `morph`. Reduced motion: no interpolation, `onDone` at once (the fitted shape is already the annotation).
 */
export function MorphStroke({
  morph,
  color,
  width,
  onDone,
}: {
  morph: Morph;
  color: Rgb;
  width: number;
  onDone: () => void;
}) {
  const target = useMemo(() => {
    const [first] = morph.from;
    return first === undefined ? [] : shapePoints(morph.to, morph.from.length, first);
  }, [morph]);
  const [t, setT] = useState(0);
  const reduce = prefersReducedMotion();

  useEffect(() => {
    if (reduce || target.length === 0) {
      onDone();
      return;
    }
    const duration = tokenMs('--motion-morph', 150);
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = duration <= 0 ? 1 : (now - began) / duration;
      setT(easeOut(progress));
      if (progress >= 1) onDone();
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // One run per morph: a new object starts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [morph]);

  if (reduce || target.length === 0) return null;
  const points = morphAt(morph.from, target, t)
    .map((p) => `${p.x},${p.y}`)
    .join(' ');
  return (
    <polyline
      data-morph=""
      points={points}
      fill="none"
      stroke={rgbToCss(color)}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={1 - t}
    />
  );
}
