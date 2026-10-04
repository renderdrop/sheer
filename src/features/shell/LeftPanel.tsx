import { GalleryVertical, ListTree, MessagesSquare, Search, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { memo, type CSSProperties } from 'react';

import { Tab, TabList, TabPanel, Tabs } from '../../components';
import { useT, type PlainKey } from '../../i18n';
import { panelWidthFor } from '../../lib/layout';
import { LEFT_PANEL_TABS, useUi, type LeftPanelTab } from '../../stores/ui';
import { Comments } from '../comments/Comments';
import { Outline, OutlineActions } from '../outline/Outline';
import { SearchPanel } from '../search/Search';
import { Thumbnails } from '../thumbnails/Thumbnails';
import { usePanelSlide } from './usePanelSlide';

interface TabSpec {
  label: PlainKey;
  icon: LucideIcon;
}

const TABS: Record<LeftPanelTab, TabSpec> = {
  thumbnails: { label: 'leftPanel.tab.pages', icon: GalleryVertical },
  outline: { label: 'leftPanel.tab.outline', icon: ListTree },
  comments: { label: 'leftPanel.tab.comments', icon: MessagesSquare },
  search: { label: 'leftPanel.tab.search', icon: Search },
};

function isLeftPanelTab(value: string): value is LeftPanelTab {
  return (LEFT_PANEL_TABS as readonly string[]).includes(value);
}

const selectTab = (tab: string) => {
  if (isLeftPanelTab(tab)) useUi.getState().setLeftPanelTab(tab);
};

export interface LeftPanelProps {
  /** The id the splitter points to with `aria-controls`. */
  id: string;
}

/**
 * The page sidebar (DESIGN v2 3.2): an `<aside>` on the Canvas surface without a border. Its header row (48) holds the four icon tabs
 * (Pages, Outline, Comments, Search; 36 each, the underline cue of 2.8) (the sidebar collapses by the top bar's toggle, the splitter's grip and View > Sidebar, DESIGN 3.5 B2). The body is the
 * selected tab's panel: thumbnails, outline, comments or search results.
 *
 * It follows the selected tab (`ui.leftPanelTab`) itself and is memoized, so it renders when the tab or its slot changes and
 * not for a page, a zoom step or a drag of the splitter next to it.
 */
export const LeftPanel = memo(function LeftPanel({ id }: LeftPanelProps) {
  const t = useT();
  const tab = useUi((state) => state.leftPanelTab);
  return (
    // The wrapper of Tabs is `display: contents`, so the panel itself is the grid item.
    <Tabs value={tab} onValueChange={selectTab} className="contents">
      <aside
        data-region="left"
        id={id}
        aria-label={t('leftPanel.label')}
        className="bg-app flex min-h-0 flex-col overflow-hidden"
      >
        <div className="flex h-12 shrink-0 items-center gap-1 px-2">
          <TabList label={t('leftPanel.views')} className="h-control-md w-auto gap-1">
            {LEFT_PANEL_TABS.map((value) => (
              <div key={value} className="flex h-control-md w-control-md">
                <Tab value={value} label={t(TABS[value].label)} icon={TABS[value].icon} />
              </div>
            ))}
          </TabList>
        </div>
        <div className="min-h-0 flex-1">
          {LEFT_PANEL_TABS.map((value) => (
            <TabPanel key={value} value={value} className="h-full">
              {/* A column: the view takes the height (the thumbnails scroll inside it). */}
              <div className="flex h-full min-h-0 flex-col">
                {value === 'thumbnails' ? (
                  <Thumbnails />
                ) : value === 'outline' ? (
                  <>
                    <div className="flex h-control-md shrink-0 items-center justify-end px-2">
                      <OutlineActions />
                    </div>
                    <Outline />
                  </>
                ) : value === 'comments' ? (
                  <Comments />
                ) : (
                  <SearchPanel />
                )}
              </div>
            </TabPanel>
          ))}
        </div>
      </aside>
    </Tabs>
  );
});

export interface LeftPanelSlotProps {
  /** The panel is shown (not collapsed). A change fades it in or out; it is gone from the page once it has faded. */
  present: boolean;
  id: string;
  /** `grid-column` of the slot. */
  style: CSSProperties;
}

/**
 * The left panel's slot of the main grid, which is there with or without the panel (its tracks only shrink to nothing when it
 * is collapsed, `shellTracks`). The panel slides in step with its track (MOTION 4.2) (opacity only under reduced motion, where the
 * track changes in one step, tokens.css), and a collapsed one is removed once it has faded, so it is neither in the page nor
 * in the tab order. The fading is this component's own state: the shell renders once for the change, and not again when the
 * panel has gone or for any frame of the track, and the memoized panel inside does not render at all.
 */
export function LeftPanelSlot({ present, id, style }: LeftPanelSlotProps) {
  return (
    // The track clips while it slides (`data-animating` of the grid), so the panel never paints outside its slot; at rest nothing
    // is clipped, which keeps the panel's shadow and focus ring. The panel is there from the first paint; only a change animates.
    <div style={style} className="grid min-h-0 min-w-0 group-data-[animating]/main:overflow-clip">
      <AnimatePresence initial={false}>{present && <LeftPanelFrame key="left" id={id} />}</AnimatePresence>
    </div>
  );
}

function LeftPanelFrame({ id }: { id: string }) {
  // The panel keeps its width whatever the track does, so nothing inside it reflows during the slide. It is the track's width,
  // widened for the Comments tab like the grid (`panelWidthFor`, F15 A5): the clamp alone left the cards 200 px wide.
  const width = useUi((state) => panelWidthFor(state.leftPanelWidth, state.leftPanelTab));
  const motionProps = usePanelSlide('start', width);
  // While it fades out the panel is on its way out: nothing in it takes focus or a click any more.
  const present = useIsPresent();
  return (
    <motion.div
      {...motionProps}
      inert={!present}
      style={{ width }}
      className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
    >
      <LeftPanel id={id} />
    </motion.div>
  );
}
