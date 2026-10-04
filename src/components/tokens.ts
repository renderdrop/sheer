/**
 * Reads a pixel token from the document (`--space-2` is `8px`). Components that must do geometry in JavaScript
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
 * Geometry of the page sidebar and its splitter in px (DESIGN v2 3.2): range, default, the width below which a released
 * drag collapses the pane, and the arrow-key steps (`--space-2` and `--space-10`). Resizing is arithmetic in JavaScript, so
 * it needs numbers; these mirror `--panel-*` and the spacing tokens of tokens.css, and tokens.test.ts fails when they
 * drift apart.
 */
export const PANEL = { min: 200, default: 200, max: 320, collapseBelow: 144, step: 8, largeStep: 40 } as const;

/** Gap between an anchor and a tooltip or popover, and margin kept to the window edge (DESIGN 3.4, 3.5: 8 px). */
export function overlayOffset(): number {
  return tokenPx('--space-2', 8);
}

/**
 * Widths of the layout grid in px (DESIGN v2 3.2) for the collapse rules, which are arithmetic in JavaScript (src/lib/layout.ts).
 * They mirror `--splitter-width`, `--canvas-min`, `--tool-sidebar-width`, `--tool-rail-width` and `--topbar-height` of
 * tokens.css, and tokens.test.ts fails when they drift apart. `railBelow` (the tool sidebar becomes the rail) and
 * `leftCollapseBelow` (the page sidebar collapses) are breakpoints of the spec with no CSS counterpart; `minWindow*` is the
 * smallest window, and `tauri.conf.json` has the minimum (tested).
 */
export const LAYOUT = {
  splitter: 8,
  canvasMin: 360,
  topbar: 56,
  toolSidebar: 280,
  toolRail: 56,
  railBelow: 1100,
  leftCollapseBelow: 860,
  minWindowWidth: 960,
  minWindowHeight: 640,
} as const;
