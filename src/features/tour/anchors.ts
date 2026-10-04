import type { Align, Side } from '../../components';

/** Where the coach mark sits next to a step's anchor, by the anchor's name in `steps.json` (DESIGN 3.14 "Slot and layer"). */
export interface AnchorSpec {
  selector: string;
  side: Side;
  align: Align;
  /** The anchor can be collapsed into More: the card then points at More and adds `tour.inMore`. */
  fallback?: string;
}

const MORE = '[data-toolbar-item="more"]';

export const ANCHORS: Readonly<Record<string, AnchorSpec>> = {
  // Toolbar: below the toolbar, centred on the anchor.
  'toolbar-zoom-in': { selector: '[data-toolbar-item="zoom-in"]', side: 'bottom', align: 'center', fallback: MORE },
  // The tools of steps 4 to 6, and the thumbnails of step 7 (DESIGN 3.46).
  'tool-highlight': { selector: '[data-toolbar-item="highlight"]', side: 'bottom', align: 'center', fallback: MORE },
  'tool-note': { selector: '[data-toolbar-item="note"]', side: 'bottom', align: 'center', fallback: MORE },
  'tool-signature': { selector: '[data-toolbar-item="signature"]', side: 'bottom', align: 'center', fallback: MORE },
  'left-panel': { selector: '[data-toolbar-item="left-panel"]', side: 'bottom', align: 'start' },
  'thumbnails-tab': { selector: '[role="tab"][data-value="thumbnails"]', side: 'bottom', align: 'start' },
  // Status bar: the card's bottom edge on the bar's top, aligned to the anchor's leading (file name) or trailing (page) edge.
  'status-file-name': { selector: '[data-tour-anchor="status-file-name"]', side: 'top', align: 'start' },
  'status-page-button': { selector: '[data-tour-anchor="status-page-button"]', side: 'top', align: 'end' },
};

export interface ResolvedAnchor {
  element: HTMLElement;
  spec: AnchorSpec;
  /** The anchor itself is in overflow: `element` is the More button. */
  inMore: boolean;
}

/** Anchors that name a page: the thumbnail in the left panel, the cell of the Organize grid. */
function pageAnchor(name: string): AnchorSpec | undefined {
  const [kind, id] = name.split(':');
  if (id === undefined || !/^d+$/.test(id)) return undefined;
  if (kind === 'thumbnail') return { selector: `[data-thumb-page="${id}"]`, side: 'right', align: 'center' };
  if (kind === 'organize') return { selector: `[data-page-id="${id}"][data-index]`, side: 'bottom', align: 'center' };
  return undefined;
}

/** The element a step's anchor names, if it is on screen. */
export function resolveAnchor(name: string): ResolvedAnchor | null {
  const spec = ANCHORS[name] ?? pageAnchor(name);
  if (spec === undefined) return null;
  const found = document.querySelector<HTMLElement>(spec.selector);
  if (found !== null) return { element: found, spec, inMore: false };
  const more = spec.fallback === undefined ? null : document.querySelector<HTMLElement>(spec.fallback);
  if (more !== null) return { element: more, spec, inMore: true };
  // Nothing of the anchor is on screen (narrow window, hidden bar): the card sits at the status bar, or else the canvas centre,
  // so the step stays readable and Skip stays reachable.
  for (const last of LAST_RESORT) {
    const element = document.querySelector<HTMLElement>(last.selector);
    if (element !== null) return { element, spec: last, inMore: false };
  }
  return null;
}

const LAST_RESORT: readonly AnchorSpec[] = [
  { selector: '[data-tour-anchor="status-page-button"]', side: 'top', align: 'end' },
  { selector: '[data-tour-anchor="status-file-name"]', side: 'top', align: 'start' },
  { selector: '[data-canvas-content]', side: 'bottom', align: 'center' },
];

/** The toolbar item of a tool (or More when it is in overflow, or the canvas when no toolbar is there): where a tool tip points (DESIGN 3.47). */
export function resolveToolbarItem(item: string): ResolvedAnchor | null {
  const spec: AnchorSpec = {
    selector: `[data-toolbar-item="${item}"]`,
    side: 'bottom',
    align: 'center',
    fallback: MORE,
  };
  const found = document.querySelector<HTMLElement>(spec.selector);
  if (found !== null) return { element: found, spec, inMore: false };
  const more = document.querySelector<HTMLElement>(MORE);
  if (more !== null) return { element: more, spec, inMore: true };
  return null;
}
