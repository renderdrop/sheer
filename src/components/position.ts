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
