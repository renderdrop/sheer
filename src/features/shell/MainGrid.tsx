import { memo, type CSSProperties, type ReactNode } from 'react';

import { Splitter } from '../../components';
import { clampPanelWidth, shellTracks, type ShellStructure } from '../../lib/layout';
import { strings } from '../../strings';
import { useUi } from '../../stores/ui';

export interface MainGridProps {
  structure: ShellStructure;
  children: ReactNode;
}

/**
 * The main row: a grid whose columns come from `shellTracks` (src/lib/layout.ts). The left panel's width goes into the
 * `grid-template-columns`, so this component follows `ui.leftPanelWidth` itself and is the only one that renders for every
 * step of a splitter drag. Its children are made by the shell and passed in, which is why they are not rendered again then:
 * React skips an element that is the same object as in the last render.
 */
export function MainGrid({ structure, children }: MainGridProps) {
  const panelWidth = useUi((state) => state.leftPanelWidth);
  return (
    <div
      data-layout={structure.mode}
      style={{ gridTemplateColumns: shellTracks(structure, panelWidth).columns }}
      className="grid min-h-0 flex-auto grid-rows-[minmax(0,1fr)] pb-1"
    >
      {children}
    </div>
  );
}

const resizeLeftPanel = (width: number) => useUi.getState().setLeftPanelWidth(width);
const collapseLeftPanel = (collapsed: boolean) => useUi.getState().setLeftPanelCollapsed(collapsed);

export interface LeftPanelSplitterProps {
  /** Id of the left panel (`aria-controls`). */
  controls: string;
  collapsed: boolean;
  /** Keep it the same object between renders: the splitter slot is memoized. */
  style?: CSSProperties;
}

/** The gutter beside the left panel with its splitter, which shows the panel's width and so follows `ui.leftPanelWidth`. */
export const LeftPanelSplitter = memo(function LeftPanelSplitter({
  controls,
  collapsed,
  style,
}: LeftPanelSplitterProps) {
  const width = useUi((state) => clampPanelWidth(state.leftPanelWidth));
  return (
    <div style={style} className="flex min-h-0">
      <Splitter
        label={strings.resizeLeftPanel}
        controls={controls}
        value={width}
        collapsed={collapsed}
        onValueChange={resizeLeftPanel}
        onCollapsedChange={collapseLeftPanel}
      />
    </div>
  );
});
