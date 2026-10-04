import { useEffect } from 'react';

/**
 * F6 / Shift+F6 region cycling (DESIGN 2.3, 3.52): toolbar, hint card, tabs, banners, left panel, splitter, canvas, inspector, status bar.
 * A region that is not on screen, or has nothing to focus, is skipped. Leaving a region remembers where focus was, and F6 back into it
 * restores that element while it is still there. Dialogs own the keyboard: with one open, F6 does nothing.
 */
export const REGIONS: readonly { id: string; selector: string }[] = [
  { id: 'toolbar', selector: '[role="toolbar"]' },
  { id: 'card', selector: '[data-tour-card], [data-tip-card]' },
  { id: 'tabs', selector: '[data-tabs]' },
  { id: 'banner', selector: '[data-region="banner"]' },
  { id: 'left', selector: '[data-region="left"]' },
  { id: 'splitter', selector: '[role="separator"]' },
  { id: 'canvas', selector: '[data-action-scope="canvas"] > [role="region"]' },
  { id: 'inspector', selector: '[data-region="inspector"]' },
  { id: 'status', selector: 'footer' },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const DIALOG = '[role="dialog"], [role="alertdialog"]';

function usable(element: HTMLElement): boolean {
  return element.closest('[inert], [hidden], [aria-hidden="true"]') === null;
}

/** Where focus goes when F6 enters `region`: its own tab stop (the canvas scroller, the splitter), else its first tab stop. */
function entry(region: HTMLElement): HTMLElement | null {
  if (region.matches(FOCUSABLE) && usable(region)) return region;
  for (const candidate of region.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (usable(candidate)) return candidate;
  }
  return null;
}

/** The regions on screen with something to focus, in cycle order. */
function present(): { id: string; element: HTMLElement }[] {
  const found: { id: string; element: HTMLElement }[] = [];
  for (const { id, selector } of REGIONS) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element !== null && usable(element) && entry(element) !== null) found.push({ id, element });
  }
  return found;
}

/**
 * Moves focus to the next (or previous) region from `active`. Returns whether focus moved. Exported for tests; `useRegionCycling`
 * wires it to the keyboard.
 */
export function cycleRegion(direction: 1 | -1, memory: Map<string, HTMLElement>): boolean {
  const regions = present();
  if (regions.length === 0) return false;
  const active = document.activeElement;
  const at = regions.findIndex(({ element }) => active !== null && element.contains(active));
  const next =
    at === -1 ? (direction === 1 ? 0 : regions.length - 1) : (at + direction + regions.length) % regions.length;
  const target = regions[next];
  if (target === undefined) return false;
  const remembered = memory.get(target.id);
  const focus =
    remembered !== undefined && remembered.isConnected && target.element.contains(remembered) && usable(remembered)
      ? remembered
      : entry(target.element);
  if (focus === null) return false;
  focus.focus();
  return true;
}

export function useRegionCycling(): void {
  useEffect(() => {
    const memory = new Map<string, HTMLElement>();
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      for (const { id, selector } of REGIONS) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element !== null && element.contains(target)) memory.set(id, target);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector(DIALOG) !== null) return;
      if (cycleRegion(event.shiftKey ? -1 : 1, memory)) event.preventDefault();
    };
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
