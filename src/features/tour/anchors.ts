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

/** The element a step's anchor names, if it is on screen. */
export function resolveAnchor(name: string): ResolvedAnchor | null {
  const spec = ANCHORS[name];
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
