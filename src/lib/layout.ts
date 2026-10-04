/**
 * The app shell's column grid and its collapse rules (DESIGN 2). Pure functions, no DOM: the shell passes in what it
 * knows (window width, the user's panel choices, whether a document is open) and gets back the track list for
 * `grid-template-columns` and the effective state of the left panel and the inspector.
 *
 * Columns with a document: `8 | left 192-400 | splitter 8 | canvas minmax(360, 1fr) | 8 | inspector 288 | 8`.
 * - Collapsed left panel: the track and the outer gutter go, the splitter becomes the leading gutter. They stay in the list at
 *   size 0 (`var(--spacing-0)`), so the list has the same tracks in the same places whether the panel is there or not: the
 *   browser can animate the change (a transition needs lists of equal length, DESIGN 3.8) and no slot moves to another column.
 * - No inspector (F2 review): nothing is reserved for it while it is not shown, so the canvas reaches the trailing gutter. Its gap and
 *   track stay in the list at size 0, like the left panel's, so the browser can animate it opening and closing.
 * - No document: `8 | empty state | 8`.
 */
import { LAYOUT, PANEL } from '../components/tokens';

export type SlotName = 'gutter-start' | 'left' | 'splitter' | 'canvas' | 'gap' | 'inspector' | 'gutter-end';

/**
 * How the user wants the inspector (DESIGN 2, 3.9): `auto` lets a selection or a tool open it (from 1280 px on, where its
 * track is reserved anyway), `open` and `closed` are the toggle's two answers.
 */
export type InspectorMode = 'auto' | 'open' | 'closed';

export interface LayoutInput {
  hasDocument: boolean;
  /** Window width in CSS px. */
  windowWidth: number;
  /** Width the user chose for the left panel; clamped to the range of the spec. */
  panelWidth: number;
  /** The user collapsed the left panel. It also collapses by itself when the canvas would get too narrow. */
  panelCollapsed: boolean;
  inspector: InspectorMode;
  /** A mode panel, a selection, or the options of a tool that has some, has something to show in the inspector. */
  inspectorContent: boolean;
  /** A mode (Crop, Redact) is on: its panel opens the inspector even when the user closed it (DESIGN 3.57). */
  inspectorMode?: boolean;
}

export interface Track {
  slot: SlotName;
  /** The CSS track size: token references, plus the left panel's chosen pixel width. */
  size: string;
}

/**
 * What the layout decides apart from pixel widths: which slots exist and whether the inspector shows. Booleans only, so it
 * changes when a rule flips (the window crossing 1280 px, the canvas falling under 360, a toggle) and not with every pixel of
 * a window resize or step of the splitter. The shell follows this and not the raw width, so it re-renders only then.
 */
export interface ShellStructure {
  mode: 'empty' | 'document';
  /** The left panel is not shown: by the user's choice or because the canvas would be narrower than 360 px. */
  leftCollapsed: boolean;
  /** Collapsed by the layout alone (the user did not ask for it). It returns when the window grows. */
  leftAutoCollapsed: boolean;
  /** The inspector's track has room: it is shown (opened by the user, or in `auto` by a selection or tool from 1280 px). */
  inspectorReserved: boolean;
  /** The inspector panel is faded in (it has a track, and the user or a selection or tool asked for it). */
  inspectorVisible: boolean;
}

/** The grid of a structure: the tracks for a left panel of the given width, and where each slot sits. */
export interface ShellTracks {
  tracks: readonly Track[];
  /** `grid-template-columns`. */
  columns: string;
  /** 1-based grid column of each slot that exists, for `grid-column`. */
  column: Readonly<Partial<Record<SlotName, number>>>;
  /** The left panel's width after clamping. */
  panelWidth: number;
}

export interface ShellLayout extends ShellStructure, ShellTracks {
  /** Width the canvas gets, in CSS px, at the minimum of its track. */
  canvasWidth: number;
}

const GUTTER = 'var(--space-1)';
/** A track that is there but takes no room: the collapsed left panel's and the hidden inspector's tracks. */
const NO_ROOM = 'var(--spacing-0)';

const EMPTY_STRUCTURE: ShellStructure = {
  mode: 'empty',
  leftCollapsed: true,
  leftAutoCollapsed: false,
  inspectorReserved: false,
  inspectorVisible: false,
};

/** `value` within the left panel's range; anything that is not a finite number gives the default. No snapping. */
export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL.default;
  return Math.min(PANEL.max, Math.max(PANEL.min, Math.round(value)));
}

function widthOf(input: LayoutInput): number {
  return Number.isFinite(input.windowWidth) ? input.windowWidth : LAYOUT.minWindowWidth;
}

/** What sits to the right of the canvas: the gap and the inspector, when its track exists, and the outer gutter. */
function trailingWidth(inspectorReserved: boolean): number {
  return (inspectorReserved ? LAYOUT.gutter + LAYOUT.inspector : 0) + LAYOUT.gutter;
}

/** The slots and the inspector's visibility for the given state (DESIGN 2). See the module comment for the rules. */
export function shellStructure(input: LayoutInput): ShellStructure {
  if (!input.hasDocument) return EMPTY_STRUCTURE;
  const panelWidth = clampPanelWidth(input.panelWidth);
  const width = widthOf(input);

  // At every width of the window (960 and up): the canvas collapse below is what protects the canvas (DESIGN 3.57).
  const inspectorVisible =
    input.inspector === 'open' ||
    (input.inspector === 'auto' && input.inspectorContent) ||
    (input.inspector === 'closed' && input.inspectorMode === true);
  const inspectorReserved = inspectorVisible;

  const canvasWithLeft = width - LAYOUT.gutter - panelWidth - LAYOUT.splitter - trailingWidth(inspectorReserved);
  const leftAutoCollapsed = !input.panelCollapsed && canvasWithLeft < LAYOUT.canvasMin;
  return {
    mode: 'document',
    leftCollapsed: input.panelCollapsed || leftAutoCollapsed,
    leftAutoCollapsed,
    inspectorReserved,
    inspectorVisible,
  };
}

/** The columns of the grid for a structure, with the left panel at `panelWidth` (clamped). */
export function shellTracks(structure: ShellStructure, panelWidth: number): ShellTracks {
  const width = clampPanelWidth(panelWidth);
  const tracks: Track[] = [];
  if (structure.mode === 'empty') {
    tracks.push(
      { slot: 'gutter-start', size: GUTTER },
      { slot: 'canvas', size: 'minmax(0, 1fr)' },
      { slot: 'gutter-end', size: GUTTER },
    );
  } else {
    // Collapsed or not, the left panel's tracks are in the list (see the module comment); only their size differs.
    tracks.push(
      { slot: 'gutter-start', size: structure.leftCollapsed ? NO_ROOM : GUTTER },
      { slot: 'left', size: structure.leftCollapsed ? NO_ROOM : `${width}px` },
    );
    tracks.push(
      { slot: 'splitter', size: 'var(--splitter-width)' },
      { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
    );
    tracks.push(
      { slot: 'gap', size: structure.inspectorReserved ? GUTTER : NO_ROOM },
      { slot: 'inspector', size: structure.inspectorReserved ? 'var(--inspector-width)' : NO_ROOM },
    );
    tracks.push({ slot: 'gutter-end', size: GUTTER });
  }
  const column: Partial<Record<SlotName, number>> = {};
  tracks.forEach((track, index) => {
    column[track.slot] = index + 1;
  });
  return { tracks, columns: tracks.map((track) => track.size).join(' '), column, panelWidth: width };
}

/** The grid for the given state (DESIGN 2): `shellStructure` and `shellTracks` together, with the canvas width. */
export function computeShellLayout(input: LayoutInput): ShellLayout {
  const structure = shellStructure(input);
  const width = widthOf(input);
  const tracks = shellTracks(structure, input.panelWidth);
  if (structure.mode === 'empty') {
    return { ...structure, ...tracks, canvasWidth: Math.max(0, width - 2 * LAYOUT.gutter) };
  }
  const trailing = trailingWidth(structure.inspectorReserved);
  const canvasWidth = structure.leftCollapsed
    ? width - LAYOUT.splitter - trailing
    : width - LAYOUT.gutter - tracks.panelWidth - LAYOUT.splitter - trailing;
  return { ...structure, ...tracks, canvasWidth };
}
