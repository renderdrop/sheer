/**
 * Reads a pixel token from the document (`--space-1` is `8px`). Components that must do geometry in JavaScript
 * (popover offset, window margin) take their numbers from here, so tokens.css stays the only place with raw values.
 * Falls back to the spec value when the token is not available (tests, no stylesheet yet).
 */
export function tokenPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && raw.endsWith('px') ? value : fallback;
}

/**
 * Geometry of the left panel and its splitter in px (DESIGN 2, 3.8): range, default, the width below which a released
 * drag collapses the pane, and the arrow-key steps (`--space-1` and `--space-5`). Resizing is arithmetic in JavaScript, so
 * it needs numbers; these mirror `--panel-*` and the spacing tokens of tokens.css, and tokens.test.ts fails when they
 * drift apart.
 */
export const PANEL = { min: 192, default: 248, max: 400, collapseBelow: 144, step: 8, largeStep: 40 } as const;

/** Gap between an anchor and a tooltip or popover, and margin kept to the window edge (DESIGN 3.4, 3.5: 8 px). */
export function overlayOffset(): number {
  return tokenPx('--space-1', 8);
}
