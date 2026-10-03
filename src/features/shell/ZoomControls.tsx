import { useMemo } from 'react';

import type { MenuEntry } from '../../components';
import { useLocale } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useDocViewValue } from '../../stores/view';
import { useViewer } from '../viewer/useViewer';
import { formatZoomStatus } from './status';
import { zoomMenuEntries } from './toolbarEntries';

/** The open document's zoom (1 without one). Only a change of the zoom re-renders what calls this, not a change of page. */
function useZoom(): number {
  const docId = useDocuments(selectActiveId);
  // NaN while the opening zoom is not known: the readouts show a dash, never a zoom the document is not at.
  return useDocViewValue(docId, (view) => (view.opening ? Number.NaN : view.zoom));
}

/**
 * The toolbar's zoom readout ("125 %"). It follows the zoom itself, so the toolbar around it renders once per document and
 * not once per zoom step (a wheel zoom makes dozens of steps a second).
 */
export function ZoomReadout() {
  return <>{formatZoomStatus(useZoom(), useLocale())}</>;
}

/** The zoom presets with the current one checked, for the toolbar's zoom menu. A hook: the menu calls it while it is open. */
export function useZoomMenu(): readonly MenuEntry[] {
  const zoom = useZoom();
  const locale = useLocale();
  const setZoom = useViewer((state) => state.setZoom);
  return useMemo(() => zoomMenuEntries(zoom, setZoom, locale), [zoom, setZoom, locale]);
}
