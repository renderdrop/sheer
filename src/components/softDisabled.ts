import type { MouseEvent } from 'react';

/**
 * Handlers that only observe, so a soft-disabled control keeps them: focus tracking (the roving tab stop of a toolbar)
 * and pointer enter/leave (hover state). Every other `on*` prop acts on input and is dropped.
 */
const PASSIVE = new Set([
  'onFocus',
  'onFocusCapture',
  'onBlur',
  'onBlurCapture',
  'onMouseEnter',
  'onMouseLeave',
  'onPointerEnter',
  'onPointerLeave',
]);

/**
 * Props of a control that is disabled but stays focusable (`aria-disabled`, DESIGN 3.0), without the handlers that act.
 * A disabled element receives every event a live one does, and callers spread handlers onto it (a popover trigger's
 * `onKeyDown`, a tool's `onDoubleClick` for the lock), so dropping them here is what keeps a soft-disabled control from
 * opening, locking or running anything. An allow-list of observers is kept instead of a block-list of actions, so a
 * handler type nobody thought of is neutralised too.
 */
export function withoutActions<T extends object>(props: T): T {
  return Object.fromEntries(Object.entries(props).filter(([name]) => !/^on[A-Z]/.test(name) || PASSIVE.has(name))) as T;
}

/**
 * `onClick` of a soft-disabled control. A click still arrives (Enter and Space on a button produce one), so it is
 * cancelled: that also stops a `type="submit"` button from submitting its form.
 */
export function cancelClick(event: MouseEvent<HTMLElement>): void {
  event.preventDefault();
}
