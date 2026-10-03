import type { MarkGlyph } from '../../../api/annotations';
import type { Rect } from '../../../api/wire';

/** The strokes of a Fill and Sign mark inside its box, as polylines (check, cross) or a circle (dot), in page space. */

const STROKE_SHARE = 0.12;

export type MarkGeometry =
  | { type: 'lines'; lines: readonly (readonly (readonly [number, number])[])[]; width: number }
  | { type: 'dot'; cx: number; cy: number; r: number };

const at = (box: Rect, u: number, v: number): [number, number] => [box.x + box.w * u, box.y + box.h * v];

export function markGeometry(glyph: MarkGlyph, box: Rect): MarkGeometry {
  const side = Math.min(box.w, box.h);
  switch (glyph) {
    case 'check':
      return {
        type: 'lines',
        lines: [[at(box, 0.12, 0.55), at(box, 0.4, 0.82), at(box, 0.88, 0.2)]],
        width: side * STROKE_SHARE,
      };
    case 'cross':
      return {
        type: 'lines',
        lines: [
          [at(box, 0.15, 0.15), at(box, 0.85, 0.85)],
          [at(box, 0.85, 0.15), at(box, 0.15, 0.85)],
        ],
        width: side * STROKE_SHARE,
      };
    case 'dot':
      return { type: 'dot', cx: box.x + box.w / 2, cy: box.y + box.h / 2, r: side * 0.3 };
  }
}
