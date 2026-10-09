/**
 * The editor's grid and its collapse rules (DESIGN v2 3.2, ADR-102). Pure functions, no DOM: the shell passes in what it knows
 * (window width, the user's panel choices, whether the editor is showing, whether the platform has a menu row) and gets back the
 * track lists for `grid-template-columns` and `grid-template-rows`.
 *
 * Rows of the editor (DESIGN 3.18 E1): `menu 28 (Windows only) | tab strip 42 | gutter 12 | mode card 106 | gutter 12 | body | status bar 30`.
 * macOS has the native menu bar, so its list has no menu track. Columns of the body: `left panel 220 (200-480) | splitter 8 |
 * canvas minmax(360, 1fr) | inspector 300 (0 when closed)`. The properties of a selection are the mini bar, an overlay of the canvas.
 * - Collapsed page sidebar: its track goes (size 0, still in the list, so the list has the same tracks in the same places
 *   whether the panel is there or not: the browser can animate the change and no slot moves to another column). The
 *   splitter stays as the leading handle. The sidebar collapses by itself below 860 px or when the canvas would get too narrow.
 * - Home (no document, or the user went back to Home): one slot, the window.
 */
import { INSPECTOR, LAYOUT, PANEL } from '../components/tokens';

/** Narrowest the page sidebar is while it shows the Comments tab: a card needs room for its type, author and text (FEEDBACK F15 A5, ADR-106). */
export const COMMENTS_PANEL_MIN = 280;

export type SlotName = 'left' | 'splitter' | 'canvas' | 'inspector';

/** The rows of the editor, top to bottom. `menu` exists on Windows only. */
export type RowName = 'menu' | 'tabs' | 'gutter-top' | 'mode' | 'gutter-mode' | 'body' | 'status';

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
  /** The inspector column is open (a tool inspector shows): it takes `--inspector-width`, else nothing. Default: no. */
  inspectorOpen?: boolean;
  /** Width the user chose for the inspector column (240 to 480); default 300. */
  inspectorWidth?: number;
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
  /** The inspector column (300) is open. */
  inspector: boolean;
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
  inspector: false,
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

/** `value` within the inspector's range; anything that is not a finite number gives the default (F20.8). */
export function clampInspectorWidth(value: number): number {
  if (!Number.isFinite(value)) return INSPECTOR.default;
  return Math.min(INSPECTOR.max, Math.max(INSPECTOR.min, Math.round(value)));
}

function widthOf(input: LayoutInput): number {
  return Number.isFinite(input.windowWidth) ? input.windowWidth : LAYOUT.minWindowWidth;
}

/** The slots and the page sidebar's state for the given input (DESIGN v2 3.2). See the module comment for the rules. */
export function shellStructure(input: LayoutInput): ShellStructure {
  if (!input.hasDocument) return EMPTY_STRUCTURE;
  const panelWidth = panelWidthFor(input.panelWidth, input.leftTab);
  const width = widthOf(input);
  const inspector = input.inspectorOpen === true;
  const canvasWithLeft =
    width -
    panelWidth -
    LAYOUT.splitter -
    (inspector ? clampInspectorWidth(input.inspectorWidth ?? INSPECTOR.default) : 0);
  const collapsedByLayout = width < LAYOUT.leftCollapseBelow || canvasWithLeft < LAYOUT.canvasMin;
  return {
    mode: 'document',
    leftCollapsed: input.panelCollapsed || collapsedByLayout,
    menuRow: input.menuRow === true,
    inspector,
  };
}

/** The rows of the grid for a structure: Home has only the body, the editor the header rows above it. */
function rowTracksOf(structure: ShellStructure): RowTrack[] {
  if (structure.mode === 'empty') return [{ row: 'body', size: 'minmax(0, 1fr)' }];
  return [
    ...(structure.menuRow ? [{ row: 'menu', size: 'var(--menubar-height)' } as const] : []),
    { row: 'tabs', size: 'var(--tabstrip-height)' },
    { row: 'gutter-top', size: 'var(--chrome-gutter)' },
    { row: 'mode', size: 'var(--mode-card-height)' },
    { row: 'gutter-mode', size: 'var(--chrome-gutter)' },
    { row: 'body', size: 'minmax(0, 1fr)' },
    { row: 'status', size: 'var(--statusbar-height)' },
  ];
}

/** The tracks of the grid for a structure, with the page sidebar at `panelWidth` (clamped). */
export function shellTracks(
  structure: ShellStructure,
  panelWidth: number,
  leftTab?: string,
  inspectorWidth: number = INSPECTOR.default,
): ShellTracks {
  const width = panelWidthFor(panelWidth, leftTab);
  const tracks: Track[] =
    structure.mode === 'empty'
      ? [{ slot: 'canvas', size: 'minmax(0, 1fr)' }]
      : [
          // Collapsed or not, the page sidebar's track is in the list (see the module comment); only its size differs.
          { slot: 'left', size: structure.leftCollapsed ? NO_ROOM : `${width}px` },
          { slot: 'splitter', size: 'var(--splitter-width)' },
          { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
          {
            slot: 'inspector',
            size: structure.inspector
              ? inspectorWidth === INSPECTOR.default
                ? 'var(--inspector-width)'
                : `${clampInspectorWidth(inspectorWidth)}px`
              : NO_ROOM,
          },
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
  const tracks = shellTracks(structure, input.panelWidth, input.leftTab, input.inspectorWidth);
  if (structure.mode === 'empty') return { ...structure, ...tracks, canvasWidth: Math.max(0, width) };
  const left = structure.leftCollapsed ? 0 : tracks.panelWidth;
  const inspector = structure.inspector ? clampInspectorWidth(input.inspectorWidth ?? INSPECTOR.default) : 0;
  return { ...structure, ...tracks, canvasWidth: width - left - LAYOUT.splitter - inspector };
}

/** The height of the body (the canvas column) in a window of `windowHeight`: what is left under the header rows. */
export function bodyHeight(structure: ShellStructure, windowHeight: number): number {
  if (structure.mode === 'empty') return windowHeight;
  const header =
    LAYOUT.tabstrip + 2 * LAYOUT.gutter + LAYOUT.modeCard + LAYOUT.statusbar + (structure.menuRow ? LAYOUT.menubar : 0);
  return windowHeight - header;
}
