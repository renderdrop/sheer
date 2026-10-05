import type { Point } from '../../../api/wire';
import type { Recognised } from './recognise';

/** `--ease-out` (cubic-bezier(0.2, 0, 0, 1)) as a function of the progress: a cubic ease-out is close enough for 150 ms. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sq = (a: Point, b: Point): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** `n` points along a closed outline, starting at the one nearest `near` so that the stroke does not twist while it morphs. */
function closed(outline: (u: number) => Point, n: number, near: Point): Point[] {
  const points = Array.from({ length: n }, (_, i) => outline(i / n));
  let start = 0;
  for (let i = 1; i < n; i++) {
    const a = points[i];
    const b = points[start];
    if (a !== undefined && b !== undefined && sq(a, near) < sq(b, near)) start = i;
  }
  return [...points.slice(start), ...points.slice(0, start)];
}

/** The fitted shape's outline as `n` points (the body of an arrow is its shaft). `near` is where the raw stroke starts. */
export function shapePoints(to: Recognised, n: number, near: Point): Point[] {
  switch (to.kind) {
    case 'line':
    case 'arrow':
      return Array.from({ length: n }, (_, i) => lerp(to.from, to.to, n === 1 ? 1 : i / (n - 1)));
    case 'rect': {
      const { x, y, w, h } = to.box;
      const corners: Point[] = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
      return closed(
        (u) => {
          const side = Math.min(3, Math.floor(u * 4));
          const a = corners[side];
          const b = corners[(side + 1) % 4];
          return a === undefined || b === undefined ? { x, y } : lerp(a, b, u * 4 - side);
        },
        n,
        near,
      );
    }
    case 'ellipse': {
      const { x, y, w, h } = to.box;
      return closed(
        (u) => ({
          x: x + w / 2 + (w / 2) * Math.cos(u * 2 * Math.PI),
          y: y + h / 2 + (h / 2) * Math.sin(u * 2 * Math.PI),
        }),
        n,
        near,
      );
    }
  }
}

/** The raw stroke `from` at `t` of its way to the fitted shape (0 is the stroke, 1 the shape); `target` has as many points as `from`. */
export function morphAt(from: readonly Point[], target: readonly Point[], t: number): Point[] {
  return from.map((p, i) => {
    const q = target[i];
    return q === undefined ? p : lerp(p, q, t);
  });
}
