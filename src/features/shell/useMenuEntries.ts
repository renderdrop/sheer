import { useMemo } from 'react';

import { hasTextSelection } from '../../actions/commentIntent';
import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { buildMenuEntries, type RecentItem } from '../../actions/menuModel';
import type { MenuEntry } from '../../components';
import { useT } from '../../i18n';
import { useForms } from '../forms/store';
import { useMarginPrefs } from '../margin/store';
import { smartLinksOn, useSmartLinks } from '../smartlinks/store';
import { useSettings } from '../../stores/settings';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useDocViewValue } from '../../stores/view';
import { useActionState } from './useActionState';
import { useShellStructure } from './useShellStructure';

/** The sidebar tab each action shows (the store calls Pages `thumbnails`). */
const TAB_OF: Readonly<Record<string, string>> = {
  'sidebar-tab-pages': 'thumbnails',
  'sidebar-tab-outline': 'outline',
  'sidebar-tab-comments': 'comments',
  'sidebar-tab-search': 'search',
};

/** The v1.2 menus have no Open recent (Home lists the recent files); the model still supports the submenu. */
const NO_RECENTS: { items: readonly RecentItem[]; clear: () => void } = { items: [], clear: () => undefined };

/**
 * The entries of one menu of the in-window bar (DESIGN v2 3.2), built from `menu.json` and the registry. A hook: the bar's menu calls
 * it while it is open (`MenuEntries` as a function), so the checks and the enabled state are those of the moment the menu is looked
 * at, and a change while it is open (a mode chosen with a key) shows at once.
 */
export function useMenuEntries(menuId: string, afterRun: () => void): readonly MenuEntry[] {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const structure = useShellStructure();
  const leftTab = useUi((ui) => ui.leftPanelTab);
  const docId = useDocuments(selectActiveId);
  const scrollMode = useDocViewValue(docId, (view) => view.scrollMode);
  const formHighlight = useForms((forms) => forms.highlight);
  const marginComments = useMarginPrefs((margin) => margin.enabled);
  const smartLinks = useSmartLinks((links) => (docId === null ? links.enabled : smartLinksOn(links, docId)));
  // The selection is read when the menu is built: it cannot change while the pointer or the keys are in the menu.
  const selection = hasTextSelection();

  return useMemo(
    () =>
      buildMenuEntries(menuId, {
        t,
        platform,
        state,
        run: (id) => {
          runAction(id);
          afterRun();
        },
        checked: (id) => {
          if (id.startsWith('scroll-')) return scrollMode === id.slice('scroll-'.length);
          if (id === 'toggle-left-panel') return !structure.leftCollapsed;
          if (id in TAB_OF) return leftTab === TAB_OF[id];
          if (id === 'form-highlight') return formHighlight;
          if (id === 'toggle-margin-comments') return marginComments;
          if (id === 'toggle-smart-links') return smartLinks;
          return undefined;
        },
        hasTextSelection: selection,
        recents: NO_RECENTS,
      }),
    [
      menuId,
      t,
      platform,
      state,
      afterRun,
      scrollMode,
      structure.leftCollapsed,
      leftTab,
      formHighlight,
      marginComments,
      smartLinks,
      selection,
    ],
  );
}
