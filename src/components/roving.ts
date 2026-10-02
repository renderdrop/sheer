/**
 * Roving focus (DESIGN 3 intro): one tab stop that remembers the last item; arrows move, Home and End jump.
 * Pure index math, shared by toolbar, tablist and menu, so every widget agrees on what the keys do.
 */
export type Orientation = 'horizontal' | 'vertical';

export interface RovingOptions {
  orientation: Orientation;
  /** Past the last item continue at the first (tablist, menu); toolbars stop at the ends. */
  wrap: boolean;
}

/**
 * Index to focus after `key`, or `null` when the key is not a navigation key here or nothing would change.
 * `current` is -1 when focus is not on an item (then arrows start from the ends).
 */
export function rovingTarget(key: string, current: number, count: number, options: RovingOptions): number | null {
  if (count === 0) return null;
  const forward = options.orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backward = options.orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  let next: number;
  switch (key) {
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    case forward:
      next = current < 0 ? 0 : current + 1;
      break;
    case backward:
      next = current < 0 ? count - 1 : current - 1;
      break;
    default:
      return null;
  }
  if (options.wrap) next = (next + count) % count;
  else next = Math.max(0, Math.min(count - 1, next));
  return next === current ? null : next;
}

/** The items of a widget in DOM order. Items are found by selector, so overflowed (unrendered) items never count. */
export function itemsOf(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

/** `true` when the event came from inside the widget's own DOM (not from a portal that React bubbles through). */
export function isOwnEvent(container: HTMLElement, event: { target: EventTarget }): boolean {
  return event.target instanceof Node && container.contains(event.target);
}
