/**
 * The editor's grid and its collapse rules (DESIGN v2 3.2, ADR-102). Pure functions, no DOM: the shell passes in what it knows
 * (window width, the user's panel choices, whether the editor is showing, whether the platform has a menu row) and gets back the
 * track lists for `grid-template-columns` and `grid-template-rows`.
 *
 * Rows of the editor: `menu 32 (Windows only) | top bar 56 | mode row 40 | tool row 48 | body`. macOS has the native menu bar, so
 * its list has no menu track. Columns of the body: `page sidebar 200-320 | splitter 8 | canvas minmax(360, 1fr)`. There is no
 * right column and no rail: the properties are the mini bar, an overlay of the canvas column.
 * - Collapsed page sidebar: its track goes (size 0, still in the list, so the list has the same tracks in the same places
 *   whether the panel is there or not: the browser can animate the change and no slot moves to another column). The
 *   splitter stays as the leading handle. The sidebar collapses by itself below 860 px or when the canvas would get too narrow.
 * - Home (no document, or the user went back to Home): one slot, the window.
 */
import { LAYOUT, PANEL } from '../components/tokens';

/** Narrowest the page sidebar is while it shows the Comments tab: a card needs room for its type, author and text (FEEDBACK F15 A5, ADR-106). */
export const COMMENTS_PANEL_MIN = 280;

export type SlotName = 'left' | 'splitter' | 'canvas';

/** The rows of the editor, top to bottom. `menu` exists on Windows only. */
export type RowName = 'menu' | 'topbar' | 'mode' | 'tool' | 'body';

export interface LayoutInput {
  /** The editor shows (a document is open and the view is not Home). */
  hasDocument: boolean;
  /** Window width in CSS px. */
  windowWidth: number;
  /** Width the user chose for the page sidebar; clamped to the range of the spec. */
  panelWidth: number;
  /** The user collapsed the page sidebar. It also collapses by itself below 860 px or when the canvas would get too narrow. */
  panelCollapsed: boolean;
  /** The platform draws its own in-window menu row (Windows). macOS has the native menu bar and no row. Default: no. */
  menuRow?: boolean;
  /** The sidebar tab that shows; the Comments tab is at least `COMMENTS_PANEL_MIN` wide. */
  leftTab?: string;
}

export interface Track {
  slot: SlotName;
  /** The CSS track size: token references, plus the page sidebar's chosen pixel width. */
  size: string;
}

export interface RowTrack {
  row: RowName;
  size: string;
}

/**
 * What the layout decides apart from pixel widths: which slots exist, whether the page sidebar shows and whether there is a menu
 * row. Booleans only, so it changes when a rule flips (the window crossing 860 px, a toggle) and not with every pixel of a window
 * resize or step of the splitter.
 */
export interface ShellStructure {
  /** `empty` is Home; `document` is the editor. */
  mode: 'empty' | 'document';
  /** The page sidebar is not shown: by the user's choice, below 860 px or because the canvas would be narrower than 360 px. */
  leftCollapsed: boolean;
  /** The editor has the menu row above the top bar (Windows). */
  menuRow: boolean;
}

/** The grid of a structure: the tracks for a page sidebar of the given width, and where each slot sits. */
export interface ShellTracks {
  tracks: readonly Track[];
  /** `grid-template-columns`. */
  columns: string;
  /** 1-based grid column of each slot that exists, for `grid-column`. */
  column: Readonly<Partial<Record<SlotName, number>>>;
  rowTracks: readonly RowTrack[];
  /** `grid-template-rows`. */
  rows: string;
  /** 1-based grid row of each row that exists. */
  row: Readonly<Partial<Record<RowName, number>>>;
  /** The page sidebar's width after clamping. */
  panelWidth: number;
}

export interface ShellLayout extends ShellStructure, ShellTracks {
  /** Width the canvas gets, in CSS px, at the minimum of its track. */
  canvasWidth: number;
}

/** A track that is there but takes no room: the collapsed page sidebar's. */
const NO_ROOM = 'var(--spacing-0)';

const EMPTY_STRUCTURE: ShellStructure = {
  mode: 'empty',
  leftCollapsed: true,
  menuRow: false,
};

/** The width the sidebar takes for `tab`: the chosen width, widened for the Comments tab. */
export function panelWidthFor(value: number, tab?: string): number {
  const width = clampPanelWidth(value);
  return tab === 'comments' ? Math.max(width, COMMENTS_PANEL_MIN) : width;
}

/** `value` within the page sidebar's range; anything that is not a finite number gives the default. No snapping. */
export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL.default;
  return Math.min(PANEL.max, Math.max(PANEL.min, Math.round(value)));
}

function widthOf(input: LayoutInput): number {
  return Number.isFinite(input.windowWidth) ? input.windowWidth : LAYOUT.minWindowWidth;
}

/** The slots and the page sidebar's state for the given input (DESIGN v2 3.2). See the module comment for the rules. */
export function shellStructure(input: LayoutInput): ShellStructure {
  if (!input.hasDocument) return EMPTY_STRUCTURE;
  const panelWidth = panelWidthFor(input.panelWidth, input.leftTab);
  const width = widthOf(input);
  const canvasWithLeft = width - panelWidth - LAYOUT.splitter;
  const collapsedByLayout = width < LAYOUT.leftCollapseBelow || canvasWithLeft < LAYOUT.canvasMin;
  return {
    mode: 'document',
    leftCollapsed: input.panelCollapsed || collapsedByLayout,
    menuRow: input.menuRow === true,
  };
}

/** The rows of the grid for a structure: Home has only the body, the editor the header rows above it. */
function rowTracksOf(structure: ShellStructure): RowTrack[] {
  if (structure.mode === 'empty') return [{ row: 'body', size: 'minmax(0, 1fr)' }];
  return [
    ...(structure.menuRow ? [{ row: 'menu', size: 'var(--menubar-height)' } as const] : []),
    { row: 'topbar', size: 'var(--topbar-height)' },
    { row: 'mode', size: 'var(--mode-row-height)' },
    { row: 'tool', size: 'var(--tool-row-height)' },
    { row: 'body', size: 'minmax(0, 1fr)' },
  ];
}

/** The tracks of the grid for a structure, with the page sidebar at `panelWidth` (clamped). */
export function shellTracks(structure: ShellStructure, panelWidth: number, leftTab?: string): ShellTracks {
  const width = panelWidthFor(panelWidth, leftTab);
  const tracks: Track[] =
    structure.mode === 'empty'
      ? [{ slot: 'canvas', size: 'minmax(0, 1fr)' }]
      : [
          // Collapsed or not, the page sidebar's track is in the list (see the module comment); only its size differs.
          { slot: 'left', size: structure.leftCollapsed ? NO_ROOM : `${width}px` },
          { slot: 'splitter', size: 'var(--splitter-width)' },
          { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
        ];
  const column: Partial<Record<SlotName, number>> = {};
  tracks.forEach((track, index) => {
    column[track.slot] = index + 1;
  });
  const rowTracks = rowTracksOf(structure);
  const row: Partial<Record<RowName, number>> = {};
  rowTracks.forEach((track, index) => {
    row[track.row] = index + 1;
  });
  return {
    tracks,
    columns: tracks.map((track) => track.size).join(' '),
    column,
    rowTracks,
    rows: rowTracks.map((track) => track.size).join(' '),
    row,
    panelWidth: width,
  };
}

/** The grid for the given state: `shellStructure` and `shellTracks` together, with the canvas width. */
export function computeShellLayout(input: LayoutInput): ShellLayout {
  const structure = shellStructure(input);
  const width = widthOf(input);
  const tracks = shellTracks(structure, input.panelWidth, input.leftTab);
  if (structure.mode === 'empty') return { ...structure, ...tracks, canvasWidth: Math.max(0, width) };
  const left = structure.leftCollapsed ? 0 : tracks.panelWidth;
  return { ...structure, ...tracks, canvasWidth: width - left - LAYOUT.splitter };
}

/** The height of the body (the canvas column) in a window of `windowHeight`: what is left under the header rows. */
export function bodyHeight(structure: ShellStructure, windowHeight: number): number {
  if (structure.mode === 'empty') return windowHeight;
  const header = LAYOUT.topbar + LAYOUT.modeRow + LAYOUT.toolRow + (structure.menuRow ? LAYOUT.menubar : 0);
  return windowHeight - header;
}
