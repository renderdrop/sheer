import { GalleryVertical, ListTree, MessagesSquare, Search, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { memo, type CSSProperties } from 'react';

import { Panel, Tab, TabList, TabPanel, Tabs } from '../../components';
import { usePanelFade } from '../../components/motion';
import { useT, type PlainKey } from '../../i18n';
import { LEFT_PANEL_TABS, useUi, type LeftPanelTab } from '../../stores/ui';

interface TabSpec {
  label: PlainKey;
  icon: LucideIcon;
  empty: PlainKey;
}

const TABS: Record<LeftPanelTab, TabSpec> = {
  thumbnails: { label: 'leftPanel.tab.thumbnails', icon: GalleryVertical, empty: 'leftPanel.empty.thumbnails' },
  outline: { label: 'leftPanel.tab.outline', icon: ListTree, empty: 'leftPanel.empty.outline' },
  comments: { label: 'leftPanel.tab.comments', icon: MessagesSquare, empty: 'leftPanel.empty.comments' },
  search: { label: 'leftPanel.tab.search', icon: Search, empty: 'leftPanel.empty.search' },
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
 * The left panel (DESIGN 3.6, 3.9): a G1 `<aside>` whose header is the four-tab segmented control (Thumbnails, Outline,
 * Comments, Search) and whose body is the selected tab's panel, starting with its 32 px title row. The tabs are
 * placeholders until M1 fills them; each says what will appear there.
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
      <Panel
        id={id}
        label={t('leftPanel.label')}
        header={
          <TabList label={t('leftPanel.views')}>
            {LEFT_PANEL_TABS.map((value) => (
              <Tab key={value} value={value} label={t(TABS[value].label)} icon={TABS[value].icon} />
            ))}
          </TabList>
        }
      >
        {LEFT_PANEL_TABS.map((value) => (
          <TabPanel key={value} value={value}>
            <div className="flex h-control-md items-center">
              <h2 className="m-0 truncate text-md font-semibold">{t(TABS[value].label)}</h2>
            </div>
            <p className="m-0 text-sm text-text-muted">{t(TABS[value].empty)}</p>
          </TabPanel>
        ))}
      </Panel>
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
 * is collapsed, `shellTracks`). The panel fades over 250 ms in step with its track (opacity only under reduced motion, where the
 * track changes in one step, tokens.css), and a collapsed one is removed once it has faded, so it is neither in the page nor
 * in the tab order. The fading is this component's own state: the shell renders once for the change, and not again when the
 * panel has gone or for any frame of the track, and the memoized panel inside does not render at all.
 */
export function LeftPanelSlot({ present, id, style }: LeftPanelSlotProps) {
  return (
    // The panel is there from the first paint; only a change animates.
    <AnimatePresence initial={false}>{present && <LeftPanelFrame key="left" id={id} style={style} />}</AnimatePresence>
  );
}

function LeftPanelFrame({ id, style }: Omit<LeftPanelSlotProps, 'present'>) {
  const motionProps = usePanelFade();
  // While it fades out the panel is on its way out: nothing in it takes focus or a click any more.
  const present = useIsPresent();
  return (
    <motion.div
      {...motionProps}
      inert={!present}
      style={style}
      className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
    >
      <LeftPanel id={id} />
    </motion.div>
  );
}
