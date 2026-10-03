import { memo, useMemo } from 'react';

import { canRunAction, runAction } from '../../actions/dispatch';
import type { Platform } from '../../api/app';
import { useT } from '../../i18n';
import { MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { historyOf, useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useTools } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { useDocViewValue } from '../../stores/view';
import { AboutDialog } from '../about/AboutDialog';
import { SignatureLibraryDialog } from '../signatures/library';
import { ToolAnnouncer } from '../annotations/layer/ToolAnnouncer';
import { SettingsPopover } from '../settings/SettingsPopover';
import { buildToolbar, type ToolbarActions } from './toolbarEntries';
import { ToolbarRow } from './ToolbarRow';
import { ZoomReadout, useZoomMenu } from './ZoomControls';

/**
 * What the toolbar's items do. Commands go through the registry (`runAction`), which reads the current state when it runs.
 * A click on a tool is a variant of the tool's action: it also releases the active tool (DESIGN 3.3), which its key does
 * not. So a click on a tool other than the active one runs the tool's action, and a click on the active one runs Select's;
 * locking (double click, Shift+Enter) has no action of its own and asks the registry whether the tool can be used. Either
 * way a tool that the registry says cannot run now (no document) does nothing, whatever the button looked like when it
 * was clicked. The object never changes, so the toolbar's entries (and with them the whole toolbar) are rebuilt only when
 * something they show changes.
 */
const ACTIONS: ToolbarActions = {
  run: runAction,
  selectTool: (tool) => void runAction(useUi.getState().activeTool === tool ? 'tool-select' : `tool-${tool}`),
  lockTool: (tool) => {
    if (canRunAction(`tool-${tool}`)) useUi.getState().lockTool(tool);
  },
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
  const markupVariant = useTools((state) => state.markup);
  const shapeVariant = useTools((state) => state.shapes);
  const docId = useDocuments(selectActiveId);
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));
  const zoomAtMin = useDocViewValue(docId, (view) => view.zoom <= MIN_ZOOM);
  const zoomAtMax = useDocViewValue(docId, (view) => view.zoom >= MAX_ZOOM);
  const scrollMode = useDocViewValue(docId, (view) => view.scrollMode);
  const canUndo = useAnnotations((state) => historyOf(state, docId).canUndo);
  const canRedo = useAnnotations((state) => historyOf(state, docId).canRedo);

  const { entries, moreItems } = useMemo(
    () =>
      buildToolbar(
        {
          t,
          platform,
          action: { hasDocument, zoomAtMin, zoomAtMax, canUndo, canRedo },
          scrollMode,
          activeTool,
          readOnly,
          toolLocked,
          markupVariant,
          shapeVariant,
          leftPanelVisible,
          inspectorVisible,
          zoomText: ZOOM_TEXT,
          zoomMenu: useZoomMenu,
        },
        ACTIONS,
      ),
    [
      t,
      platform,
      hasDocument,
      activeTool,
      readOnly,
      toolLocked,
      markupVariant,
      shapeVariant,
      leftPanelVisible,
      inspectorVisible,
      zoomAtMin,
      zoomAtMax,
      canUndo,
      canRedo,
      scrollMode,
    ],
  );

  return (
    <>
      <ToolbarRow entries={entries} moreItems={moreItems} trafficLightInset={trafficLightInset} />
      {/* Portals, so they take no room in the shell: the settings popover hangs from the toolbar (it opens from More or its key), the About dialog is a modal. */}
      <ToolAnnouncer />
      <SettingsPopover />
      <AboutDialog />
      <SignatureLibraryDialog />
    </>
  );
});
