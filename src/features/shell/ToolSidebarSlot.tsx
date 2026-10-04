import { memo, type CSSProperties } from 'react';

import { LAYOUT } from '../../components/tokens';
import { ToolRail, ToolSidebar } from '../tools';

export interface ToolSidebarSlotProps {
  /** The full 280 sidebar is shown; otherwise the 56 rail (below 1100 wide, or closed by the user). */
  visible: boolean;
  /** `grid-column` of the slot. */
  style: CSSProperties;
}

/**
 * The tool sidebar's slot of the editor grid (DESIGN v2 3.2): White, 1px border at the left. The tool sidebar, or the rail of tool icons
 * (`features/tools`). The track animates in `MainGrid`; the slot clips while it does, and the sidebar keeps its width so nothing inside
 * reflows.
 */
export const ToolSidebarSlot = memo(function ToolSidebarSlot({ visible, style }: ToolSidebarSlotProps) {
  return (
    <div
      style={style}
      data-slot="tool-sidebar"
      className="bg-panel grid min-h-0 min-w-0 border-s border-border-subtle group-data-[animating]/main:overflow-clip"
    >
      {visible ? (
        <div
          style={{ width: LAYOUT.toolSidebar }}
          className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] justify-self-end"
        >
          <ToolSidebar />
        </div>
      ) : (
        <ToolRail />
      )}
    </div>
  );
});
