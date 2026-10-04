/**
 * The editor's column grid and its collapse rules (DESIGN v2 3.2). Pure functions, no DOM: the shell passes in what it
 * knows (window width, the user's panel choices, whether the editor is showing) and gets back the track list for
 * `grid-template-columns` and the effective state of the page sidebar and the tool sidebar.
 *
 * Columns in the editor: `page sidebar 200-320 | splitter 8 | canvas minmax(360, 1fr) | tool sidebar 280`.
 * - Collapsed page sidebar: its track goes (size 0, still in the list, so the list has the same tracks in the same places
 *   whether the panel is there or not: the browser can animate the change and no slot moves to another column). The
 *   splitter stays as the leading handle. The sidebar collapses by itself below 860 px or when the canvas would get too narrow.
 * - Tool sidebar: 280 wide, becoming the 56 rail below 1100 px or when the user closed it. A mode panel (Crop, Redact) opens it
 *   anyway, and so does the user's explicit `open`.
 * - Home (no document, or the user went back to Home): one slot, the window.
 */
import { LAYOUT, PANEL } from '../components/tokens';

export type SlotName = 'left' | 'splitter' | 'canvas' | 'tool';

/**
 * How the user wants the tool sidebar: `auto` follows the window (the full sidebar from 1100 px on, the rail below), `open` and
 * `closed` (the rail) are the toggle's two answers. This is the collapse state of the tool sidebar.
 */
export type InspectorMode = 'auto' | 'open' | 'closed';

export interface LayoutInput {
  /** The editor shows (a document is open and the view is not Home). */
  hasDocument: boolean;
  /** Window width in CSS px. */
  windowWidth: number;
  /** Width the user chose for the page sidebar; clamped to the range of the spec. */
  panelWidth: number;
  /** The user collapsed the page sidebar. It also collapses by itself below 860 px or when the canvas would get too narrow. */
  panelCollapsed: boolean;
  inspector: InspectorMode;
  /** A mode (Crop, Redact) is on: its panel needs the full tool sidebar (DESIGN 3.57). */
  inspectorMode?: boolean;
}

export interface Track {
  slot: SlotName;
  /** The CSS track size: token references, plus the page sidebar's chosen pixel width. */
  size: string;
}

/**
 * What the layout decides apart from pixel widths: which slots exist, whether the page sidebar shows and whether the tool
 * sidebar is full or the rail. Booleans only, so it changes when a rule flips (the window crossing 1100 px, a toggle) and not
 * with every pixel of a window resize or step of the splitter.
 */
export interface ShellStructure {
  /** `empty` is Home; `document` is the editor. */
  mode: 'empty' | 'document';
  /** The page sidebar is not shown: by the user's choice, below 860 px or because the canvas would be narrower than 360 px. */
  leftCollapsed: boolean;
  /** Collapsed by the layout alone (the user did not ask for it). It returns when the window grows. */
  leftAutoCollapsed: boolean;
  /** The tool column exists (in the editor): the sidebar or the rail. */
  inspectorReserved: boolean;
  /** The full 280 sidebar is shown; otherwise the 56 rail. */
  inspectorVisible: boolean;
}

/** The grid of a structure: the tracks for a page sidebar of the given width, and where each slot sits. */
export interface ShellTracks {
  tracks: readonly Track[];
  /** `grid-template-columns`. */
  columns: string;
  /** 1-based grid column of each slot that exists, for `grid-column`. */
  column: Readonly<Partial<Record<SlotName, number>>>;
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
  leftAutoCollapsed: false,
  inspectorReserved: false,
  inspectorVisible: false,
};

/** `value` within the page sidebar's range; anything that is not a finite number gives the default. No snapping. */
export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL.default;
  return Math.min(PANEL.max, Math.max(PANEL.min, Math.round(value)));
}

function widthOf(input: LayoutInput): number {
  return Number.isFinite(input.windowWidth) ? input.windowWidth : LAYOUT.minWindowWidth;
}

/** The tool column's width: the sidebar or the rail. */
function toolWidth(visible: boolean): number {
  return visible ? LAYOUT.toolSidebar : LAYOUT.toolRail;
}

/** The slots and the tool sidebar's state for the given input (DESIGN v2 3.2). See the module comment for the rules. */
export function shellStructure(input: LayoutInput): ShellStructure {
  if (!input.hasDocument) return EMPTY_STRUCTURE;
  const panelWidth = clampPanelWidth(input.panelWidth);
  const width = widthOf(input);

  const inspectorVisible =
    input.inspector === 'open' ||
    input.inspectorMode === true ||
    (input.inspector === 'auto' && width >= LAYOUT.railBelow);

  const canvasWithLeft = width - panelWidth - LAYOUT.splitter - toolWidth(inspectorVisible);
  const leftAutoCollapsed =
    !input.panelCollapsed && (width < LAYOUT.leftCollapseBelow || canvasWithLeft < LAYOUT.canvasMin);
  return {
    mode: 'document',
    leftCollapsed: input.panelCollapsed || leftAutoCollapsed,
    leftAutoCollapsed,
    inspectorReserved: true,
    inspectorVisible,
  };
}

/** The columns of the grid for a structure, with the page sidebar at `panelWidth` (clamped). */
export function shellTracks(structure: ShellStructure, panelWidth: number): ShellTracks {
  const width = clampPanelWidth(panelWidth);
  const tracks: Track[] =
    structure.mode === 'empty'
      ? [{ slot: 'canvas', size: 'minmax(0, 1fr)' }]
      : [
          // Collapsed or not, the page sidebar's track is in the list (see the module comment); only its size differs.
          { slot: 'left', size: structure.leftCollapsed ? NO_ROOM : `${width}px` },
          { slot: 'splitter', size: 'var(--splitter-width)' },
          { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
          { slot: 'tool', size: structure.inspectorVisible ? 'var(--tool-sidebar-width)' : 'var(--tool-rail-width)' },
        ];
  const column: Partial<Record<SlotName, number>> = {};
  tracks.forEach((track, index) => {
    column[track.slot] = index + 1;
  });
  return { tracks, columns: tracks.map((track) => track.size).join(' '), column, panelWidth: width };
}

/** The grid for the given state: `shellStructure` and `shellTracks` together, with the canvas width. */
export function computeShellLayout(input: LayoutInput): ShellLayout {
  const structure = shellStructure(input);
  const width = widthOf(input);
  const tracks = shellTracks(structure, input.panelWidth);
  if (structure.mode === 'empty') return { ...structure, ...tracks, canvasWidth: Math.max(0, width) };
  const left = structure.leftCollapsed ? 0 : tracks.panelWidth;
  const canvasWidth = width - left - LAYOUT.splitter - toolWidth(structure.inspectorVisible);
  return { ...structure, ...tracks, canvasWidth };
}
