import type { ReactNode } from 'react';

import type { Platform } from '../../api/app';
import { cx } from '../../components/cx';
import { TabStrip } from '../tabs/TabStrip';
import { ToolbarSlot } from './ToolbarSlot';
import { ViewerStatusBar } from './ViewerStatusBar';

export interface TopBarSlotProps {
  platform: Platform | null;
  hasDocument: boolean;
  /** The page sidebar is shown (not collapsed by the user or by the layout). */
  leftPanelVisible: boolean;
  /** The full tool sidebar is shown (not the rail). */
  inspectorVisible: boolean;
  /** macOS, not in full screen: the traffic lights float over the start of the bar. */
  trafficLightInset: boolean;
  /** The Windows caption buttons, flush right; `null` elsewhere. */
  captionControls: ReactNode;
}

/**
 * The editor's top bar slot (DESIGN v2 3.2): 56 high, White, 1px border below, empty space is the drag region. TEMPORARY content so the
 * app stays usable until the top bar package: the document tabs, today's tool toolbar, the page and zoom controls of the old status bar
 * (the file name is in the tabs) and the caption controls, squeezed into the one row.
 */
export function TopBarSlot({
  platform,
  hasDocument,
  leftPanelVisible,
  inspectorVisible,
  trafficLightInset,
  captionControls,
}: TopBarSlotProps) {
  return (
    <div
      data-slot="topbar"
      data-tauri-drag-region="deep"
      className={cx(
        'bg-panel flex h-topbar min-w-0 items-center border-b border-border-subtle',
        trafficLightInset && 'ps-chrome-inset',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <TabStrip />
      </div>
      <div className="flex min-w-0 flex-3 items-center">
        <div className="min-w-0 flex-1">
          <ToolbarSlot
            platform={platform}
            hasDocument={hasDocument}
            leftPanelVisible={leftPanelVisible}
            inspectorVisible={inspectorVisible}
            trafficLightInset={false}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <ViewerStatusBar />
      </div>
      {captionControls}
    </div>
  );
}
