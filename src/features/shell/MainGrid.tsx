import { useReducedMotion } from 'motion/react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type TransitionEvent,
} from 'react';

import { Splitter } from '../../components';
import { DURATION } from '../../components/motion';
import { clampPanelWidth, shellTracks, type ShellStructure } from '../../lib/layout';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { setLayoutAnimating } from '../viewer/scrollBridge';

export interface MainGridProps {
  structure: ShellStructure;
  children: ReactNode;
}

/**
 * How long the grid keeps its `grid-template-columns` transition after the left panel was collapsed or restored: the slow duration of
 * the transition (MOTION 2) plus a margin. This is only the fallback: the clip is released by the grid's own
 * `transitionend` (below), so dropping the property never cuts the settle short; the timer covers a transition that never fires.
 */
const COLLAPSE_TRANSITION_MS = DURATION.slow * 1000 + 50;

interface Seen {
  mode: ShellStructure['mode'];
  collapsed: boolean;
  /** The page sidebar's track is sliding now. */
  animating: 'left' | null;
}

/**
 * The editor's body: a grid whose columns come from `shellTracks` (src/lib/layout.ts). The left panel's width goes into the
 * `grid-template-columns`, so this component follows `ui.leftPanelWidth` itself and is the only one that renders for every
 * step of a splitter drag. Its children are made by the shell and passed in, which is why they are not rendered again then:
 * React skips an element that is the same object as in the last render.
 *
 * Collapsing or restoring the left panel animates the columns (the spring, slow in and base out, `transition-[grid-template-columns]`). The track
 * list keeps its shape for that (the collapsed panel's tracks are 0), and the browser does every frame: nothing renders for it.
 * The transition is there only for a moment after the panel's state changed: a drag of the splitter changes the same property
 * and must follow the pointer at once. `data-animating` and `data-left` also let tokens.css make the change opacity-only
 * under reduced motion (the panel fades, then a collapse takes the tracks away in one step). While it runs the canvas is told
 * (`setLayoutAnimating`): it anchors itself and commits its new size once at the end.
 */
export function MainGrid({ structure, children }: MainGridProps) {
  const panelWidth = useUi((state) => state.leftPanelWidth);
  const leftTab = useUi((state) => state.leftPanelTab);
  const { mode, leftCollapsed: collapsed } = structure;
  const [seen, setSeen] = useState<Seen>({ mode, collapsed, animating: null });
  // A new state of the panel in a window that keeps its mode slides. A window that opens or closes a document has other
  // columns altogether (Home has one), which the browser cannot animate between: they just change.
  if (seen.mode !== mode) setSeen({ mode, collapsed, animating: null });
  else if (seen.collapsed !== collapsed) setSeen({ mode, collapsed, animating: 'left' });
  useEffect(() => {
    if (seen.animating === null) return;
    const timer = window.setTimeout(() => setSeen({ ...seen, animating: null }), COLLAPSE_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [seen]);
  // Under reduced motion the tracks change in one step, so there is nothing for the canvas to hold back.
  const reduce = useReducedMotion() === true;
  const sliding = seen.animating !== null && !reduce;
  useLayoutEffect(() => {
    if (!sliding) return;
    setLayoutAnimating(true);
    return () => setLayoutAnimating(false);
  }, [sliding, seen.animating]);
  const release = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-columns') return;
    setSeen((current) => (current.animating === null ? current : { ...current, animating: null }));
  };
  // What opens takes the slow duration, what closes the base one (MOTION 2).
  const closing = seen.animating === 'left' && collapsed;
  return (
    <div
      data-layout={structure.mode}
      data-left={collapsed ? 'collapsed' : 'open'}
      data-animating={seen.animating ?? undefined}
      onTransitionEnd={release}
      style={{ gridTemplateColumns: shellTracks(structure, panelWidth, leftTab).columns }}
      className={`group/main grid min-h-0 flex-auto grid-rows-[minmax(0,1fr)] ${
        seen.animating === null
          ? ''
          : `transition-[grid-template-columns] ease-out ${closing ? 'duration-base' : 'duration-slow'}`
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
