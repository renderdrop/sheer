import { PanelRight } from 'lucide-react';
import { memo, type CSSProperties } from 'react';

import { runAction } from '../../actions/dispatch';
import { IconButton } from '../../components';
import { LAYOUT } from '../../components/tokens';
import { useT } from '../../i18n';
import { Inspector } from './Inspector';

export interface ToolSidebarSlotProps {
  /** The full 280 sidebar is shown; otherwise the 56 rail (below 1100 wide, or closed by the user). */
  visible: boolean;
  /** `grid-column` of the slot. */
  style: CSSProperties;
}

/**
 * The tool sidebar's slot of the editor grid (DESIGN v2 3.2): White, 1px border at the left. TEMPORARY content: today's inspector
 * fills the sidebar, and the rail holds only the button that opens it, until the tool sidebar package. The track animates in
 * `MainGrid`; the slot clips while it does, and the sidebar keeps its width so nothing inside reflows.
 */
export const ToolSidebarSlot = memo(function ToolSidebarSlot({ visible, style }: ToolSidebarSlotProps) {
  const t = useT();
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
          <Inspector />
        </div>
      ) : (
        <div
          role="group"
          data-region="inspector"
          aria-label={t('inspector.label')}
          className="flex min-h-0 flex-col items-center gap-1 py-2"
        >
          <IconButton
            icon={PanelRight}
            label={t('toolbar.inspector')}
            onClick={() => void runAction('toggle-inspector')}
          />
        </div>
      )}
    </div>
  );
});
