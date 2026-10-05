/** Placement of tooltips and popovers (DESIGN 3.4, 3.5): preferred side, flip, and keep inside the window margin. */
export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PositionInput {
  anchor: Rect;
  floating: Size;
  viewport: Size;
  side: Side;
  align: Align;
  /** Gap between anchor and floating element. */
  offset: number;
  /** Minimum distance to the window edge. */
  margin: number;
  /**
   * Shift along the other axis, in px, applied before the element is kept inside the window. A submenu lines its first
   * item up with the item that opened it with the negative padding of its panel. Default 0.
   */
  crossOffset?: number;
}

export interface PositionResult {
  x: number;
  y: number;
  /** The side actually used, after flipping. */
  side: Side;
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function isVertical(side: Side): boolean {
  return side === 'top' || side === 'bottom';
}

function room(side: Side, anchor: Rect, viewport: Size, margin: number): number {
  switch (side) {
    case 'top':
      return anchor.top - margin;
    case 'bottom':
      return viewport.height - (anchor.top + anchor.height) - margin;
    case 'left':
      return anchor.left - margin;
    case 'right':
      return viewport.width - (anchor.left + anchor.width) - margin;
  }
}

/** Keeps `value` in [low, high]; an element larger than the window starts at `low`. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

function crossStart(align: Align, anchorStart: number, anchorSize: number, floatingSize: number): number {
  switch (align) {
    case 'start':
      return anchorStart;
    case 'center':
      return anchorStart + anchorSize / 2 - floatingSize / 2;
    case 'end':
      return anchorStart + anchorSize - floatingSize;
  }
}

/** The kinds of floating surface the one engine places (DESIGN 3.9 Q8). */
export type FloatingKind = 'tooltip' | 'popover' | 'menu' | 'coach' | 'tip';

/** Gap from the anchor per kind in px (Q8): tooltip, popover, menu and tip 8, coach mark 12. */
export function gapOf(kind: FloatingKind): number {
  return kind === 'coach' ? 12 : 8;
}

export interface Candidate {
  side: Side;
  align: Align;
}

/** The side the other axis ends with when the preferred alignment does not fit: start becomes end and the reverse. */
function otherAlign(align: Align): Align {
  return align === 'start' ? 'end' : align === 'end' ? 'start' : 'center';
}

/**
 * Placement order (Q8). Tooltip: top, bottom, right, left. Popover and menu: bottom-start, bottom-end, top-start, top-end,
 * right, left. Coach mark and tip: the preferred side, its opposite, the remaining two. A preferred side other than the
 * default starts the order there with the same rules.
 */
export function candidatesFor(kind: FloatingKind, side: Side, align: Align): Candidate[] {
  const opposite = OPPOSITE[side];
  const rest = (isVertical(side) ? (['right', 'left'] as const) : (['top', 'bottom'] as const)).filter(
    (candidate) => candidate !== side,
  );
  if (kind === 'popover' || kind === 'menu') {
    const second = otherAlign(align);
    const list: Candidate[] = [{ side, align }];
    if (second !== align && isVertical(side)) list.push({ side, align: second });
    list.push({ side: opposite, align });
    if (second !== align && isVertical(side)) list.push({ side: opposite, align: second });
    for (const remaining of rest) list.push({ side: remaining, align: isVertical(remaining) ? align : 'start' });
    return list;
  }
  return [side, opposite, ...rest].map((candidate) => ({ side: candidate, align }));
}

export function intersects(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlapX > 0.5 && overlapY > 0.5;
}

export interface PlacementInput {
  anchor: Rect;
  floating: Size;
  viewport: Size;
  kind: FloatingKind;
  side: Side;
  align: Align;
  offset: number;
  /** Viewport inset (8). */
  margin: number;
  crossOffset?: number;
  /** Rects the surface must not intersect. Empty rects (no area) never collide. */
  protectedRects: readonly Rect[];
  /** A candidate below the anchor starts no higher than this (the tool row the card must not hide). */
  minTop?: number;
  /** Horizontal range (viewport coordinates) the box stays inside, inside the inset; the viewport when left out. */
  xRange?: { min: number; max: number };
}

/**
 * Walks the candidates in order (`candidatesFor`). Per candidate: the main axis must fit inside the inset (the flip is the
 * next candidate on the opposite side), then the element is shifted along the edge to stay inside the inset, then it is
 * tested against the protected rects. The first candidate without a collision wins. `null` when none does: a popover then
 * becomes a dialog, a tooltip or tip is not shown, a notice waits.
 */
export function computePlacement(input: PlacementInput): PositionResult | null {
  const { anchor, floating, viewport, offset, margin, crossOffset = 0 } = input;
  const rangeMin = Math.max(margin, input.xRange?.min ?? margin);
  const rangeMax = Math.min(viewport.width - margin, input.xRange?.max ?? viewport.width - margin);
  const maxX = Math.max(rangeMin, rangeMax - floating.width);
  const maxY = viewport.height - margin - floating.height;
  // Larger than the viewport minus the inset: no candidate can hold it.
  if (maxX < margin || maxY < margin) return null;
  for (const { side, align } of candidatesFor(input.kind, input.side, input.align)) {
    let x: number;
    let y: number;
    if (isVertical(side)) {
      x = crossStart(align, anchor.left, anchor.width, floating.width) + crossOffset;
      y = side === 'bottom' ? anchor.top + anchor.height + offset : anchor.top - offset - floating.height;
      if (side === 'bottom' && input.minTop !== undefined) y = Math.max(y, input.minTop);
      if (y < margin - 0.01 || y > maxY + 0.01) continue;
      x = clamp(x, rangeMin, maxX);
    } else {
      y = crossStart(align, anchor.top, anchor.height, floating.height) + crossOffset;
      x = side === 'right' ? anchor.left + anchor.width + offset : anchor.left - offset - floating.width;
      if (x < margin - 0.01 || x > maxX + 0.01) continue;
      y = clamp(y, margin, maxY);
    }
    const box: Rect = { left: x, top: y, width: floating.width, height: floating.height };
    const hit = input.protectedRects.filter((rect) => intersects(box, rect));
    if (hit.length === 0) return { x, y, side };
    // A coach mark may slide along the edge to the nearest free spot beside what it hit (a banner next to the anchor's column).
    if (input.kind === 'coach' && isVertical(side)) {
      const spots = hit
        .flatMap((rect) => [rect.left - floating.width, rect.left + rect.width])
        .map((left) => clamp(left, rangeMin, maxX))
        .sort((a, b) => Math.abs(a - x) - Math.abs(b - x));
      for (const left of spots) {
        const slid: Rect = { ...box, left };
        if (!input.protectedRects.some((rect) => intersects(slid, rect))) return { x: left, y, side };
      }
    }
  }
  return null;
}

/**
 * Top-left corner (viewport coordinates) for a `position: fixed` element. The preferred side is used when the element
 * fits there; otherwise the opposite side if it has more room. Along the other axis the element is shifted to stay
 * `margin` inside the window. The gap to the anchor is kept, so the anchor is never covered while there is room.
 */
export function computePosition(input: PositionInput): PositionResult {
  const { anchor, floating, viewport, align, offset, margin, crossOffset = 0 } = input;
  let side = input.side;
  const need = (candidate: Side) => (isVertical(candidate) ? floating.height : floating.width) + offset;

  if (room(side, anchor, viewport, margin) < need(side)) {
    const opposite = OPPOSITE[side];
    if (room(opposite, anchor, viewport, margin) > room(side, anchor, viewport, margin)) side = opposite;
  }

  let x: number;
  let y: number;
  if (isVertical(side)) {
    x = crossStart(align, anchor.left, anchor.width, floating.width) + crossOffset;
    y = side === 'bottom' ? anchor.top + anchor.height + offset : anchor.top - offset - floating.height;
  } else {
    y = crossStart(align, anchor.top, anchor.height, floating.height) + crossOffset;
    x = side === 'right' ? anchor.left + anchor.width + offset : anchor.left - offset - floating.width;
  }

  return {
    x: clamp(x, margin, viewport.width - margin - floating.width),
    y: clamp(y, margin, viewport.height - margin - floating.height),
    side,
  };
}
