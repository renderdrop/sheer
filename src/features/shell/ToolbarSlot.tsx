import { memo, useMemo } from 'react';

import { canRunAction, runAction } from '../../actions/dispatch';
import { NO_DOCUMENT } from '../../actions/state';
import type { Platform } from '../../api/app';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useTools } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { buildToolbar, type ToolbarActions } from './toolbarEntries';
import { ToolbarRow } from './ToolbarRow';

/**
 * What the toolbar's items do. Commands go through the registry (`runAction`), which reads the current state when it runs.
 * A click on a tool is a variant of the tool's action: it also releases the active tool (DESIGN 3.3), which its key does
 * not. So a click on a tool other than the active one runs the tool's action, and a click on the active one runs Select's;
 * locking (double click, Shift+Enter) has no action of its own and asks the registry whether the tool can be used. Either
 * way a tool that the registry says cannot run now (no document) does nothing, whatever the button looked like when it
 * was clicked. The object never changes, so the toolbar's entries are rebuilt only when something they show changes.
 */
const ACTIONS: ToolbarActions = {
  run: runAction,
  selectTool: (tool) => void runAction(useUi.getState().activeTool === tool ? 'tool-select' : `tool-${tool}`),
  lockTool: (tool) => {
    if (canRunAction(`tool-${tool}`)) useUi.getState().lockTool(tool);
  },
  // Redact is a mode: the item ends it when it is on (Select's action), and starts it otherwise.
  toggleRedact: () => {
    if (useUi.getState().redactMode) useUi.getState().setRedactMode(false);
    else void runAction('tool-redact');
  },
};

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
 * The toolbar row with its items: it subscribes to exactly what the items show (the active tool, the tool variants, whether a
 * document is open) and gets the rest as props, builds the entries once per change of those, and so renders when a tool is
 * chosen, not for a page, a zoom step, a splitter drag or a render.
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
  const redactMode = useUi((state) => state.redactMode);
  const markupVariant = useTools((state) => state.markup);
  const shapeVariant = useTools((state) => state.shapes);
  const docId = useDocuments(selectActiveId);
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));

  const { leading, trailing, groups } = useMemo(
    () =>
      buildToolbar(
        {
          t,
          platform,
          action: { ...NO_DOCUMENT, hasDocument },
          activeTool,
          redactMode,
          readOnly,
          toolLocked,
          markupVariant,
          shapeVariant,
          leftPanelVisible,
          inspectorVisible,
        },
        ACTIONS,
      ),
    [
      t,
      platform,
      hasDocument,
      activeTool,
      redactMode,
      readOnly,
      toolLocked,
      markupVariant,
      shapeVariant,
      leftPanelVisible,
      inspectorVisible,
    ],
  );

  return <ToolbarRow leading={leading} trailing={trailing} groups={groups} trafficLightInset={trafficLightInset} />;
});
