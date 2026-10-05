import type { ToolId } from '../../stores/ui';

/**
 * Cursors over the page (MOTION spell 12): one data attribute on the canvas root, `data-cursor`, names the cursor; tokens.css
 * (R5-B) maps each name to its SVG (`src/assets/cursors`, drawn for 2x with exact hotspots). Everywhere else, and for the tools
 * that are not listed, the cursor stays what the element under the pointer says.
 */
export type CursorKind = 'marker' | 'pen' | 'crosshair' | 'text';

/** The hotspots in CSS px of the 2x SVGs (32 units drawn at 16 px), mirrored by tokens.css; the tests hold both. */
export const CURSOR_HOTSPOTS: Readonly<Record<CursorKind, readonly [number, number]>> = {
  marker: [2, 14],
  pen: [2, 14],
  crosshair: [8, 8],
  text: [8, 8],
};

/** The cursor a tool shows over a page, `undefined` for the tools that keep the default. */
export function cursorForTool(tool: ToolId): CursorKind | undefined {
  switch (tool) {
    case 'highlight':
      return 'marker';
    case 'draw':
      return 'pen';
    case 'shapes':
    case 'note':
    case 'image':
    case 'crop':
      return 'crosshair';
    case 'text':
    case 'textBox':
      return 'text';
    default:
      return undefined;
  }
}
