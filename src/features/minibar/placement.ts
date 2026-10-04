/** A box in client (viewport) coordinates. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Distance of the bar from the selection with its handles, and from the canvas edge (DESIGN v2 3.3), in px. */
export const MINIBAR_GAP = 8;
export const MINIBAR_INSET = 8;

export type Placement =
  | { mode: 'above' | 'below'; left: number; top: number }
  /** Neither side has room: the bar goes to the banner slot's second row. */
  | { mode: 'dock' };

export function unionOf(boxes: readonly Box[]): Box | null {
  const [first, ...rest] = boxes;
  if (first === undefined) return null;
  return rest.reduce<Box>(
    (all, b) => ({
      left: Math.min(all.left, b.left),
      top: Math.min(all.top, b.top),
      right: Math.max(all.right, b.right),
      bottom: Math.max(all.bottom, b.bottom),
    }),
    first,
  );
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * Where the bar goes (DESIGN v2 3.3): `selection` is the box of the selection including its handles. The bar is centred above it, 8 away;
 * when that leaves the canvas (`bounds`, with the 8 inset) it goes below; when that does not fit either it docks. Horizontally it is
 * clamped into the canvas. The bar never overlaps the selection or its handles.
 */
export function placeBar(selection: Box, bar: { width: number; height: number }, bounds: Box): Placement {
  const minLeft = bounds.left + MINIBAR_INSET;
  const maxLeft = bounds.right - MINIBAR_INSET - bar.width;
  // A bar wider than the canvas starts at the inset.
  const centred = (selection.left + selection.right) / 2 - bar.width / 2;
  const left = maxLeft < minLeft ? minLeft : clamp(centred, minLeft, maxLeft);
  const above = selection.top - MINIBAR_GAP - bar.height;
  if (above >= bounds.top + MINIBAR_INSET) return { mode: 'above', left, top: above };
  const below = selection.bottom + MINIBAR_GAP;
  if (below + bar.height <= bounds.bottom - MINIBAR_INSET) return { mode: 'below', left, top: below };
  return { mode: 'dock' };
}
