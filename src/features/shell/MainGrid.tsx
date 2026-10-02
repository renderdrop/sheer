import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { Splitter } from '../../components';
import { DURATION } from '../../components/motion';
import { clampPanelWidth, shellTracks, type ShellStructure } from '../../lib/layout';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';

export interface MainGridProps {
  structure: ShellStructure;
  children: ReactNode;
}

/**
 * How long the grid keeps its `grid-template-columns` transition after the left panel was collapsed or restored: the 250 ms of
 * the transition (DESIGN 3.8) and a little more, because dropping the property while it runs would cut the transition short.
 */
const COLLAPSE_TRANSITION_MS = DURATION.slow * 1000 + 50;

/**
 * The main row: a grid whose columns come from `shellTracks` (src/lib/layout.ts). The left panel's width goes into the
 * `grid-template-columns`, so this component follows `ui.leftPanelWidth` itself and is the only one that renders for every
 * step of a splitter drag. Its children are made by the shell and passed in, which is why they are not rendered again then:
 * React skips an element that is the same object as in the last render.
 *
 * Collapsing or restoring the left panel animates the columns (250 ms ease-out, `transition-[grid-template-columns]`). The track
 * list keeps its shape for that (the collapsed panel's tracks are 0), and the browser does every frame: nothing renders for it.
 * The transition is there only for 300 ms after the panel's state changed: a drag of the splitter changes the same property
 * and must follow the pointer at once. `data-animating` and `data-left` also let tokens.css make the change opacity-only
 * under reduced motion (the panel fades, then a collapse takes the tracks away in one step).
 */
export function MainGrid({ structure, children }: MainGridProps) {
  const panelWidth = useUi((state) => state.leftPanelWidth);
  const { mode, leftCollapsed: collapsed } = structure;
  const [seen, setSeen] = useState({ mode, collapsed, animating: false });
  // A new state of the panel in a window that keeps its mode slides. A window that opens or closes a document has other
  // columns altogether (the empty state has three), which the browser cannot animate between: they just change.
  if (seen.mode !== mode) setSeen({ mode, collapsed, animating: false });
  else if (seen.collapsed !== collapsed) setSeen({ mode, collapsed, animating: true });
  useEffect(() => {
    if (!seen.animating) return;
    const timer = window.setTimeout(() => setSeen({ ...seen, animating: false }), COLLAPSE_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [seen]);
  return (
    <div
      data-layout={structure.mode}
      data-left={collapsed ? 'collapsed' : 'open'}
      data-animating={seen.animating ? '' : undefined}
      style={{ gridTemplateColumns: shellTracks(structure, panelWidth).columns }}
      className={`grid min-h-0 flex-auto grid-rows-[minmax(0,1fr)] pb-1 ${
        seen.animating ? 'transition-[grid-template-columns] duration-slow ease-out' : ''
      }`}
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
  const t = useT();
  const width = useUi((state) => clampPanelWidth(state.leftPanelWidth));
  return (
    <div style={style} className="flex min-h-0">
      <Splitter
        label={t('leftPanel.resize')}
        controls={controls}
        value={width}
        collapsed={collapsed}
        onValueChange={resizeLeftPanel}
        onCollapsedChange={collapseLeftPanel}
      />
    </div>
  );
});
