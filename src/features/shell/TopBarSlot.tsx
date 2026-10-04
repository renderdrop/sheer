import type { ReactNode } from 'react';

import type { Platform } from '../../api/app';
import { TopBar } from '../topbar/TopBar';

export interface TopBarSlotProps {
  platform?: Platform | null;
  hasDocument?: boolean;
  leftPanelVisible?: boolean;
  inspectorVisible?: boolean;
  /** macOS, not in full screen: the traffic lights float over the start of the bar. */
  trafficLightInset: boolean;
  /** The Windows caption buttons, flush right; `null` elsewhere. */
  captionControls: ReactNode;
}

/**
 * The editor's top bar slot (DESIGN v2 3.2): the content is `src/features/topbar`. The optional props are what the layout used
 * to hand to the old toolbar; the top bar reads what it needs from the stores itself.
 */
export function TopBarSlot({ trafficLightInset, captionControls }: TopBarSlotProps) {
  return <TopBar trafficLightInset={trafficLightInset} captionControls={captionControls} />;
}
