import type { Align, Side } from '../../components';
import type { Mode } from '../../stores/ui';

/** Where the coach mark sits next to a step's anchor, by the anchor's name in `steps.json` (DESIGN 3.14 "Slot and layer"). */
export interface AnchorSpec {
  selector: string;
  side: Side;
  align: Align;
  /** The mode whose tool row holds the anchor; the step switches to it first (ADR-102). */
  mode?: Mode;
}

export const ANCHORS: Readonly<Record<string, AnchorSpec>> = {
  // Toolbar: below the toolbar, centred on the anchor.
  'toolbar-zoom-in': { selector: '[data-toolbar-item="zoom-in"]', side: 'bottom', align: 'center' },
  // The tools of steps 4 to 6, and the thumbnails of step 7 (DESIGN 3.46).
  'tool-highlight': { selector: '[data-toolbar-item="highlight"]', side: 'bottom', align: 'center', mode: 'comment' },
  'tool-note': { selector: '[data-toolbar-item="note"]', side: 'bottom', align: 'center', mode: 'comment' },
  'tool-signature': { selector: '[data-toolbar-item="signature"]', side: 'bottom', align: 'center', mode: 'fill' },
  'left-panel': { selector: '[data-toolbar-item="left-panel"]', side: 'bottom', align: 'start' },
  'thumbnails-tab': { selector: '[role="tab"][data-value="thumbnails"]', side: 'bottom', align: 'start' },
  // Status bar: the card's bottom edge on the bar's top, aligned to the anchor's leading (file name) or trailing (page) edge.
  'status-file-name': { selector: '[data-tour-anchor="status-file-name"]', side: 'top', align: 'start' },
  'status-page-button': { selector: '[data-tour-anchor="status-page-button"]', side: 'top', align: 'end' },
};

export interface ResolvedAnchor {
  element: HTMLElement;
  spec: AnchorSpec;
}

/** Anchors that name a page: the thumbnail in the left panel, the cell of the Organize grid. */
function pageAnchor(name: string): AnchorSpec | undefined {
  const [kind, id] = name.split(':');
  if (id === undefined || !/^\d+$/.test(id)) return undefined;
  if (kind === 'thumbnail') return { selector: `[data-thumb-page="${id}"]`, side: 'right', align: 'center' };
  if (kind === 'organize') return { selector: `[data-page-id="${id}"][data-index]`, side: 'bottom', align: 'center' };
  return undefined;
}

/** The element a step's anchor names, if it is on screen. */
export function resolveAnchor(name: string): ResolvedAnchor | null {
  const spec = ANCHORS[name] ?? pageAnchor(name);
  if (spec === undefined) return null;
  const found = document.querySelector<HTMLElement>(spec.selector);
  if (found !== null) return { element: found, spec };
  // Nothing of the anchor is on screen (narrow window, hidden bar): the card sits at the status bar, or else the canvas centre,
  // so the step stays readable and Skip stays reachable.
  for (const last of LAST_RESORT) {
    const element = document.querySelector<HTMLElement>(last.selector);
    if (element !== null) return { element, spec: last };
  }
  return null;
}

const LAST_RESORT: readonly AnchorSpec[] = [
  { selector: '[data-tour-anchor="status-page-button"]', side: 'top', align: 'end' },
  { selector: '[data-tour-anchor="status-file-name"]', side: 'top', align: 'start' },
  { selector: '[data-canvas-content]', side: 'bottom', align: 'center' },
];

/** The mode a step's anchor lives in, or `null` when it is in every mode (the top bar, the status bar, the left panel). */
export function modeOfAnchor(name: string): Mode | null {
  return ANCHORS[name]?.mode ?? (name.startsWith('organize:') ? 'pages' : null);
}

/** The toolbar item of a tool: where a tool tip points (DESIGN 3.47). */
export function resolveToolbarItem(item: string): ResolvedAnchor | null {
  const spec: AnchorSpec = { selector: `[data-toolbar-item="${item}"]`, side: 'bottom', align: 'center' };
  const found = document.querySelector<HTMLElement>(spec.selector);
  return found === null ? null : { element: found, spec };
}
