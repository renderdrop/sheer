/** Zoom 1 = 100 % = 96 CSS px per inch. Pure functions, no DOM. */

export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/** CSS pixels per PDF point (1 pt = 1/72 in, 1 CSS px = 1/96 in). */
export const CSS_PX_PER_PT = 96 / 72;

/** Ctrl+wheel sensitivity: zoom factor per CSS pixel of wheel delta. */
const WHEEL_ZOOM_RATE = 0.0015;
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 800;
const STEP_EPSILON = 1e-6;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Next preset zoom above (direction 1) or below (direction -1) `zoom`; stays at the limit. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) {
    for (const step of ZOOM_STEPS) {
      if (step > zoom + STEP_EPSILON) return step;
    }
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = ZOOM_STEPS[i];
    if (step !== undefined && step < zoom - STEP_EPSILON) return step;
  }
  return MIN_ZOOM;
}

/**
 * Width kept free when a page is fitted to the canvas's width: a page that exactly fills the canvas is taller than it, so a
 * classic vertical scrollbar appears and would push a horizontal one in. Overlay scrollbars (macOS) simply leave a little
 * more margin.
 */
export const FIT_SCROLLBAR_PX = 16;

/**
 * A fit zoom rounded DOWN to a thousandth: the zoom is stored and applied with limited precision, and rounding to nearest could make a
 * page that fits a fraction of a pixel too wide, which brings a horizontal scrollbar. The epsilon keeps an exact fit exact.
 */
export function floorFit(zoom: number): number {
  return clampZoom(Math.floor(zoom * 1000 + 1e-6) / 1000);
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The zoom at which a page of `pageWidthPt` fills `viewportWidthPx` (the canvas's content width, padding excluded) less
 * `FIT_SCROLLBAR_PX`, clamped to the zoom range. `null` when a size is not a positive number (nothing measured yet).
 */
export function fitWidthZoom(viewportWidthPx: number, pageWidthPt: number): number | null {
  if (!isPositive(viewportWidthPx) || !isPositive(pageWidthPt)) return null;
  return floorFit(Math.max(0, viewportWidthPx - FIT_SCROLLBAR_PX) / (pageWidthPt * CSS_PX_PER_PT));
}

/**
 * The zoom at which the whole page fits in the canvas's content box: the smaller of the width fit and the height fit,
 * clamped to the zoom range. No scrollbar allowance: a page that fits needs no scrollbar. `null` when a size is not a
 * positive number.
 */
export function fitPageZoom(
  viewportWidthPx: number,
  viewportHeightPx: number,
  pageWidthPt: number,
  pageHeightPt: number,
): number | null {
  if (![viewportWidthPx, viewportHeightPx, pageWidthPt, pageHeightPt].every(isPositive)) return null;
  return floorFit(
    Math.min(viewportWidthPx / (pageWidthPt * CSS_PX_PER_PT), viewportHeightPx / (pageHeightPt * CSS_PX_PER_PT)),
  );
}

/** The factor a Ctrl/Cmd+wheel step zooms by (a trackpad pinch arrives as ctrl+wheel). Scrolling up (negative delta) zooms in. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const unit = deltaMode === 1 ? PIXELS_PER_LINE : deltaMode === 2 ? PIXELS_PER_PAGE : 1;
  const factor = Math.exp(-deltaY * unit * WHEEL_ZOOM_RATE);
  return Number.isFinite(factor) ? factor : 1;
}

/** Continuous zoom for Ctrl/Cmd+wheel and trackpad pinch. Scrolling up (negative delta) zooms in. */
export function wheelZoom(zoom: number, deltaY: number, deltaMode = 0): number {
  return clampZoom(zoom * wheelFactor(deltaY, deltaMode));
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
