import { Toolbar, type MenuEntry, type ToolbarEntry } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { AuthorPromptField } from '../author/AuthorPromptField';

export interface ToolbarRowProps {
  entries: readonly ToolbarEntry[];
  moreItems: readonly MenuEntry[];
  /**
   * macOS: the traffic lights float over the start of the row, so the toolbar starts 80 px in (DESIGN 2.2). In full
   * screen the lights are gone and the inset is the normal 8.
   */
  trafficLightInset: boolean;
}

/**
 * The toolbar row (DESIGN 2): 56 high, the 40 px toolbar with 8 px above, below and at the sides. It is also a drag region
 * for the window: the empty parts of the row and of the toolbar's glass drag it, and a double click maximizes (items are
 * buttons, which never drag). That is what lets macOS do without a title bar (`titleBarStyle: Overlay`).
 */
export function ToolbarRow({ entries, moreItems, trafficLightInset }: ToolbarRowProps) {
  const t = useT();
  return (
    <div
      data-tauri-drag-region="deep"
      className={cx(
        'flex h-toolbar-row shrink-0 items-center py-1 pe-1',
        trafficLightInset ? 'ps-chrome-inset' : 'ps-1',
      )}
    >
      <Toolbar
        label={t('toolbar.label')}
        entries={entries}
        moreItems={moreItems}
        className="min-w-0 flex-auto [&_[aria-disabled=true]]:opacity-(--opacity-disabled)"
      />
      <AuthorPromptField />
    </div>
  );
}
