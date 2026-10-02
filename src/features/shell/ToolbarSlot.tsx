import { memo, useMemo } from 'react';

import { runAction } from '../../actions/dispatch';
import type { Platform } from '../../api/app';
import { useT } from '../../i18n';
import { MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { useUi } from '../../stores/ui';
import { useDocViewValue } from '../../stores/view';
import { selectDocId, useViewer } from '../viewer/useViewer';
import { buildToolbar, type ToolbarActions } from './toolbarEntries';
import { ToolbarRow } from './ToolbarRow';
import { ZoomReadout, useZoomMenu } from './ZoomControls';

/**
 * What the toolbar's items do. Commands go through the registry (`runAction`), which reads the current state when it runs; a
 * click on a tool is the toolbar's own. So the object never changes and the toolbar's entries (and with them the whole
 * toolbar) are rebuilt only when something they show changes.
 */
const ACTIONS: ToolbarActions = {
  run: runAction,
  selectTool: (tool) => useUi.getState().selectTool(tool),
  lockTool: (tool) => useUi.getState().lockTool(tool),
};

/** The readout and the preset menu follow the zoom themselves (see `ZoomControls`). */
const ZOOM_TEXT = <ZoomReadout />;

export interface ToolbarSlotProps {
  platform: Platform | null;
  hasDocument: boolean;
  /** The left panel is shown (not collapsed by the user or by the layout). */
  leftPanelVisible: boolean;
  inspectorVisible: boolean;
  /** macOS, not in full screen: the traffic lights float over the start of the row. */
  trafficLightInset: boolean;
}

/**
 * The toolbar row with its items: it subscribes to exactly what the items show (the active tool, whether the zoom is at
 * either end) and gets the rest as props, builds the entries once per change of those, and so renders when a tool is
 * chosen or a limit is reached, not for a page, a zoom step, a splitter drag or a render.
 */
export const ToolbarSlot = memo(function ToolbarSlot({
  platform,
  hasDocument,
  leftPanelVisible,
  inspectorVisible,
  trafficLightInset,
}: ToolbarSlotProps) {
  const t = useT();
  const activeTool = useUi((state) => state.activeTool);
  const toolLocked = useUi((state) => state.toolLocked);
  const docId = useViewer(selectDocId);
  const zoomAtMin = useDocViewValue(docId, (view) => view.zoom <= MIN_ZOOM);
  const zoomAtMax = useDocViewValue(docId, (view) => view.zoom >= MAX_ZOOM);

  const { entries, moreItems } = useMemo(
    () =>
      buildToolbar(
        {
          t,
          platform,
          action: { hasDocument, zoomAtMin, zoomAtMax },
          activeTool,
          toolLocked,
          leftPanelVisible,
          inspectorVisible,
          zoomText: ZOOM_TEXT,
          zoomMenu: useZoomMenu,
        },
        ACTIONS,
      ),
    [t, platform, hasDocument, activeTool, toolLocked, leftPanelVisible, inspectorVisible, zoomAtMin, zoomAtMax],
  );

  return <ToolbarRow entries={entries} moreItems={moreItems} trafficLightInset={trafficLightInset} />;
});
