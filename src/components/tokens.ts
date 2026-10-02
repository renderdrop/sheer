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

/**
 * Widths of the layout grid in px (DESIGN 2) for the collapse rules, which are arithmetic in JavaScript (src/lib/layout.ts).
 * They mirror `--space-1` (the 8 px gutters and the gap before the inspector), `--splitter-width`, `--canvas-min` and
 * `--inspector-width` of tokens.css, and tokens.test.ts fails when they drift apart. `inspectorReserveFrom` is the window
 * width from which the inspector track stays reserved while a document is open, `minWindow*` the smallest window; both are
 * breakpoints of the spec (2) with no CSS counterpart, and `tauri.conf.json` has the window minimum (tested).
 */
export const LAYOUT = {
  gutter: 8,
  splitter: 8,
  canvasMin: 360,
  inspector: 288,
  inspectorReserveFrom: 1280,
  minWindowWidth: 960,
  minWindowHeight: 640,
} as const;
