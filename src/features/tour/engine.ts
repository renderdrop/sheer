/**
 * The completion conditions of the welcome tour's steps (DESIGN 3.14), as pure functions of what the view stores report. The
 * store reports a zoom only once it has been committed at rest, so "at rest" needs no check here.
 */

/** The page must hold still this long before the Navigate step counts (the page announcement's delay, DESIGN 3.10). */
export const NAVIGATE_SETTLE_MS = 500;

/** How long the "done" card is held before the next step (or the end) follows, ms. */
export const HOLD_MS = 1200;

/** What the engine knows of the document's view. */
export interface ViewReading {
  /** Zero-based current page. */
  pageIndex: number;
  zoom: number;
}

/** What was true when the step started. */
export interface Baseline {
  zoom: number;
}

/**
 * Whether the state satisfies the step right now. `open` has no state to read: the engine completes it once the first frame has
 * faded in. A step this does not know is never complete by itself.
 */
export function isSatisfied(stepId: string, view: ViewReading, baseline: Baseline): boolean {
  switch (stepId) {
    case 'navigate':
      return view.pageIndex >= 1;
    case 'zoom':
      return view.zoom > baseline.zoom + 1e-9;
    default:
      return false;
  }
}

/** Steps whose condition has to hold for `NAVIGATE_SETTLE_MS` before it counts (scrolling settles first). */
export function settleDelay(stepId: string): number {
  return stepId === 'navigate' ? NAVIGATE_SETTLE_MS : 0;
}
