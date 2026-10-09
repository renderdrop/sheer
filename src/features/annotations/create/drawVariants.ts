import type { Sample } from './ink';
import { fitFreehandShape } from './shapeFit';

/**
 * The variants of Draw (F19.26): free hand stays as drawn (smoothed only, never straightened or turned into a geometric shape),
 * the free arrow gets an arrowhead at its end, the free shape closes a nearly closed loop as a recognised, hand-drawn shape (F21.5, `shapeFit.ts`). Pure functions; page space (points).
 */
export const DRAW_VARIANTS = ['free', 'arrow', 'shape'] as const;
export type DrawVariant = (typeof DRAW_VARIANTS)[number];

/** The direction comes from the last tenth of the path length. */
const DIRECTION_SHARE = 0.1;
const HEAD_ANGLE = (28 * Math.PI) / 180;
/** Arrowhead length: a base plus a multiple of the stroke width, in points. */
const HEAD_BASE_PT = 6;
const HEAD_PER_WIDTH = 3;
const NEUTRAL = 0.5;

function pathLength(stroke: readonly Sample[]): number {
  let length = 0;
  for (let i = 1; i < stroke.length; i += 1) {
    const a = stroke[i - 1];
    const b = stroke[i];
    if (a !== undefined && b !== undefined) length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/** The unit direction the stroke ends in, from the point one tenth of the path length before its end; null for a dot. */
export function endDirection(stroke: readonly Sample[]): { x: number; y: number } | null {
  const end = stroke[stroke.length - 1];
  if (end === undefined || stroke.length < 2) return null;
  const target = pathLength(stroke) * DIRECTION_SHARE;
  let walked = 0;
  for (let i = stroke.length - 2; i >= 0; i -= 1) {
    const a = stroke[i];
    const b = stroke[i + 1];
    if (a === undefined || b === undefined) continue;
    walked += Math.hypot(b.x - a.x, b.y - a.y);
    if (walked >= target || i === 0) {
      const dx = end.x - a.x;
      const dy = end.y - a.y;
      const len = Math.hypot(dx, dy);
      return len === 0 ? null : { x: dx / len, y: dy / len };
    }
  }
  return null;
}

/** The two short strokes of an arrowhead at the end of `stroke`; none for a dot. */
export function arrowheadStrokes(stroke: readonly Sample[], width: number): Sample[][] {
  const end = stroke[stroke.length - 1];
  const dir = endDirection(stroke);
  if (end === undefined || dir === null) return [];
  const length = HEAD_BASE_PT + HEAD_PER_WIDTH * Math.max(width, 0);
  const wing = (angle: number): Sample[] => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // The reverse of the direction, turned by `angle`.
    const bx = -(dir.x * cos - dir.y * sin);
    const by = -(dir.x * sin + dir.y * cos);
    return [
      { x: end.x, y: end.y, pressure: NEUTRAL },
      { x: end.x + bx * length, y: end.y + by * length, pressure: NEUTRAL },
    ];
  };
  return [wing(HEAD_ANGLE), wing(-HEAD_ANGLE)];
}

/**
 * The freehand shape (F21.5): a nearly closed stroke becomes a fitted circle, ellipse or rectangle with the stroke's own slight
 * wobble, or else closes with a smooth periodic spline; it stays ink points either way. An open stroke is returned unchanged.
 */
export function closeLoop(stroke: readonly Sample[], width: number): Sample[] {
  return fitFreehandShape(stroke, width)?.points ?? stroke.map((s) => ({ ...s }));
}

/** The strokes a finished (smoothed) stroke becomes in a Draw variant; the stroke itself comes first. */
export function applyDrawVariant(variant: DrawVariant, stroke: readonly Sample[], width: number): Sample[][] {
  switch (variant) {
    case 'arrow':
      return [stroke.map((s) => ({ ...s })), ...arrowheadStrokes(stroke, width)];
    case 'shape':
      return [closeLoop(stroke, width)];
    default:
      return [stroke.map((s) => ({ ...s }))];
  }
}
