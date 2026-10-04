/** A box in the canvas content, px. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One drifting shape: its centre in the content, its diameter, and the drift (direction signs and phase 0..1). */
export interface DriftShape {
  cx: number;
  cy: number;
  size: number;
  dx: 1 | -1;
  dy: 1 | -1;
  phase: number;
}

export function inflate(rect: Rect, by: number): Rect {
  return { left: rect.left - by, top: rect.top - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

function meets(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Up to three shapes (DESIGN 3.5 B12), spread down the content and alternating between the left and the right gutter, so a
 * short document gets fewer. `sizes` are the three diameters (min to max), `gutter` is `[leftEdge, rightEdge]` of the pages.
 */
export function placeShapes(
  content: { width: number; height: number },
  gutter: { left: number; right: number },
  sizes: readonly [number, number, number],
): DriftShape[] {
  if (!(content.width > 0) || !(content.height > 0)) return [];
  const count = Math.min(3, Math.max(1, Math.ceil(content.height / 1200)));
  const shapes: DriftShape[] = [];
  for (let i = 0; i < count; i += 1) {
    const leftSide = i % 2 === 0;
    // The middle of the gutter on that side (the content's own edge to the pages' edge).
    const cx = leftSide ? gutter.left / 2 : (gutter.right + content.width) / 2;
    shapes.push({
      cx,
      cy: ((i + 0.5) / count) * content.height,
      size: sizes[i % 3] as number,
      dx: leftSide ? 1 : -1,
      dy: i % 2 === 0 ? 1 : -1,
      phase: i / 3,
    });
  }
  return shapes;
}

/** The part of the content a shape can ever be in: its box plus the drift travel on every side. */
export function shapeFrame(shape: DriftShape, travel: number): Rect {
  const side = shape.size + 2 * travel;
  return { left: shape.cx - side / 2, top: shape.cy - side / 2, width: side, height: side };
}

/**
 * The rectangles to cut out of `frame`: every obstacle (page, margin column) inflated by the clearance, clipped to the frame
 * and given in the frame's own coordinates. Obstacles that do not meet it are left out, so a long document costs nothing.
 */
export function maskRects(frame: Rect, obstacles: readonly Rect[], clearance: number): Rect[] {
  const cuts: Rect[] = [];
  for (const obstacle of obstacles) {
    const grown = inflate(obstacle, clearance);
    if (!meets(frame, grown)) continue;
    const left = Math.max(grown.left, frame.left);
    const top = Math.max(grown.top, frame.top);
    const right = Math.min(grown.left + grown.width, frame.left + frame.width);
    const bottom = Math.min(grown.top + grown.height, frame.top + frame.height);
    cuts.push({ left: left - frame.left, top: top - frame.top, width: right - left, height: bottom - top });
  }
  return cuts;
}

/** A CSS `mask-image` that shows the whole frame except `cuts`. */
export function maskImage(frame: Rect, cuts: readonly Rect[]): string {
  const num = (value: number): number => Math.round(value * 10) / 10;
  const holes = cuts
    .map(
      (c) =>
        `<rect x='${num(c.left)}' y='${num(c.top)}' width='${num(c.width)}' height='${num(c.height)}' fill='black'/>`,
    )
    .join('');
  const w = num(frame.width);
  const h = num(frame.height);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<mask id='m'><rect width='${w}' height='${h}' fill='white'/>${holes}</mask>` +
    `<rect width='${w}' height='${h}' fill='black' mask='url(%23m)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;
}
