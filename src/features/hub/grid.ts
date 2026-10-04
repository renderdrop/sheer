export interface CardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The card to focus after `key` in the 2D tool grid (DESIGN 3.54): arrows move by position, no wrap; Home and End jump.
 * Up and Down go to the nearest card (by centre) in the nearest row above or below. `null` when nothing would change.
 */
export function gridTarget(key: string, current: number, rects: readonly CardRect[]): number | null {
  const count = rects.length;
  if (count === 0) return null;
  const from = Math.max(0, current);
  let next: number;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = count - 1;
  else if (key === 'ArrowRight') next = Math.min(count - 1, from + 1);
  else if (key === 'ArrowLeft') next = Math.max(0, from - 1);
  else if (key === 'ArrowDown' || key === 'ArrowUp') {
    const here = rects[from];
    if (here === undefined) return null;
    const sign = key === 'ArrowDown' ? 1 : -1;
    const centre = here.left + here.width / 2;
    let best: number | null = null;
    let bestRow = Number.POSITIVE_INFINITY;
    let bestColumn = Number.POSITIVE_INFINITY;
    rects.forEach((rect, index) => {
      const row = (rect.top - here.top) * sign;
      // Another row on the side the key points to.
      if (row <= rect.height / 2) return;
      const column = Math.abs(rect.left + rect.width / 2 - centre);
      if (row < bestRow || (row === bestRow && column < bestColumn)) {
        best = index;
        bestRow = row;
        bestColumn = column;
      }
    });
    if (best === null) return null;
    next = best;
  } else return null;
  return next === current ? null : next;
}
