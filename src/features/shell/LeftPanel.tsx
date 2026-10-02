import { GalleryVertical, ListTree, MessagesSquare, Search, type LucideIcon } from 'lucide-react';
import { memo, type CSSProperties } from 'react';

import { Panel, Tab, TabList, TabPanel, Tabs } from '../../components';
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
  /** Keep it the same object between renders: the panel is memoized, and a new style object would defeat that. */
  style?: CSSProperties;
}

/**
 * The left panel (DESIGN 3.6, 3.9): a G1 `<aside>` whose header is the four-tab segmented control (Thumbnails, Outline,
 * Comments, Search) and whose body is the selected tab's panel, starting with its 32 px title row. The tabs are
 * placeholders until M1 fills them; each says what will appear there.
 *
 * It follows the selected tab (`ui.leftPanelTab`) itself and is memoized, so it renders when the tab or its slot changes and
 * not for a page, a zoom step or a drag of the splitter next to it.
 */
export const LeftPanel = memo(function LeftPanel({ id, style }: LeftPanelProps) {
  const t = useT();
  const tab = useUi((state) => state.leftPanelTab);
  return (
    // The wrapper of Tabs is `display: contents`, so the panel itself is the grid item.
    <Tabs value={tab} onValueChange={selectTab} className="contents">
      <Panel
        id={id}
        label={t('leftPanel.label')}
        style={style}
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
