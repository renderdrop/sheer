import { useCallback, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { isOwnEvent, itemsOf } from '../../components/roving';

/** The attribute that names an item inside a roving group. */
export const ROVING_ATTR = 'data-roving-id';
const SELECTOR = `[${ROVING_ATTR}]`;

/** Where an arrow key leads in a list laid out in rows of `columns` (1 for a plain list); `null` when it leads nowhere. */
export function gridTarget(key: string, current: number, count: number, columns: number): number | null {
  if (count === 0) return null;
  let next: number;
  switch (key) {
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    case 'ArrowRight':
      next = current + 1;
      break;
    case 'ArrowLeft':
      next = current - 1;
      break;
    case 'ArrowDown':
      next = current + columns;
      break;
    case 'ArrowUp':
      next = current - columns;
      break;
    default:
      return null;
  }
  // Down from the last row stays; Up from the first row stays.
  if (next < 0 || next >= count) return null;
  return next === current ? null : next;
}

/** The number of items in the first visual row. */
function columnsOf(items: readonly HTMLElement[]): number {
  const first = items[0];
  if (first === undefined) return 1;
  return Math.max(1, items.filter((item) => item.offsetTop === first.offsetTop).length);
}

export interface RovingGroup {
  /** Props of the container. */
  groupProps: {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onFocus: (event: FocusEvent<HTMLElement>) => void;
  };
  /** `0` for the one item that is the group's tab stop, else `-1`. */
  tabIndexOf: (id: string) => 0 | -1;
}

/**
 * One tab stop for a list of items that arrows move through (DESIGN 3 intro): the item last focused, or the first. Items carry
 * `data-roving-id`. Arrows are for a grid, or for a single column when `list` is set; Home and End jump.
 */
export function useRovingGroup(ids: readonly string[], list = false): RovingGroup {
  const [active, setActive] = useState<string | null>(null);
  const current = active !== null && ids.includes(active) ? active : (ids[0] ?? null);

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const id = (event.target as HTMLElement).getAttribute?.(ROVING_ATTR);
    if (id !== null && id !== undefined) setActive(id);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const container = event.currentTarget;
      if (!isOwnEvent(container, event)) return;
      const items = itemsOf(container, SELECTOR);
      const index = items.findIndex((item) => item === event.target);
      if (index < 0) return;
      const target = gridTarget(event.key, index, items.length, list ? 1 : columnsOf(items));
      if (target === null) return;
      event.preventDefault();
      items[target]?.focus();
    },
    [list],
  );

  return { groupProps: { onKeyDown, onFocus }, tabIndexOf: (id) => (id === current ? 0 : -1) };
}
