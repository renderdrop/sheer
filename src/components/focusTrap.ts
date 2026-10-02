import type { KeyboardEvent } from 'react';

import { itemsOf } from './roving';

/**
 * What a Tab press can land on: not disabled and not taken out of the tab order. A roving group (a toolbar, the segmented
 * controls) keeps `tabindex="-1"` on all of its members but one, so it offers exactly one stop here: counting every enabled
 * button would make the last button in the DOM the end of the cycle, although Tab never stops on it.
 */
export const TAB_STOPS =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), ' +
  'select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not([disabled])';

/**
 * Keeps Tab and Shift+Tab inside `container`: from the last tab stop Tab goes to the first, and from the first Shift+Tab goes
 * to the last (also from the container itself, which takes focus when nothing inside has it). Anywhere else the browser's own
 * move stays inside by itself. Call it from the container's `onKeyDown`; the Popover (dialog role) and the About dialog do.
 */
export function cycleTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  const stops = itemsOf(container, TAB_STOPS);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    // Nothing to land on: focus stays where it is.
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
