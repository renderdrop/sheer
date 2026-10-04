import { useCallback, useEffect, useMemo, useState } from 'react';

import { runAction } from '../../actions/dispatch';
import { hasTextSelection } from '../../actions/commentIntent';
import { currentPlatform } from '../../actions/keys';
import { buildMenuEntries, type RecentItem } from '../../actions/menuModel';
import type { MenuEntry } from '../../components';
import { listRecents, openRecent, removeRecent, type RecentEntry } from '../../api/recents';
import { toAppError } from '../../api/errors';
import { useT } from '../../i18n';
import { useForms } from '../forms/store';
import { useSettings } from '../../stores/settings';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useDocViewValue } from '../../stores/view';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { MAX_RECENT_ROWS } from './recents';
import { useActionState } from './useActionState';
import { useShellStructure } from './useShellStructure';

/** The sidebar tab each action shows (the store calls Pages `thumbnails`). */
const TAB_OF: Readonly<Record<string, string>> = {
  'sidebar-tab-pages': 'thumbnails',
  'sidebar-tab-outline': 'outline',
  'sidebar-tab-comments': 'comments',
  'sidebar-tab-search': 'search',
};

/** The most recent files of the Open recent submenu and what choosing or clearing them does. Read when the menu is built. */
function useRecentItems(): { items: readonly RecentItem[]; clear: () => void } {
  const t = useT();
  const [entries, setEntries] = useState<readonly RecentEntry[]>([]);
  const refresh = useCallback(() => {
    listRecents().then(setEntries, () => setEntries([]));
  }, []);
  useEffect(refresh, [refresh]);

  const items = useMemo(
    () =>
      entries.slice(0, MAX_RECENT_ROWS).map((entry): RecentItem => ({
        id: String(entry.id),
        label: entry.displayName === '' ? t('status.untitled') : entry.displayName,
        onSelect: () => {
          if (entry.missing) return;
          openRecent(entry.id).then(
            (outcome) => adoptOpenOutcomes([outcome]),
            (caught: unknown) => useUi.getState().showBanner(toAppError(caught)),
          );
        },
      })),
    [entries, t],
  );
  const clear = useCallback(() => {
    const ids = entries.map((entry) => entry.id);
    void Promise.all(ids.map((id) => removeRecent(id).catch(() => undefined))).then(refresh);
  }, [entries, refresh]);
  return { items, clear };
}

/**
 * The entries of one menu of the in-window bar (DESIGN 3.56), built from `menu.json` and the registry. A hook: the bar's menu calls
 * it while it is open (`MenuEntries` as a function), so the checks, the enabled state and the recent files are those of the moment
 * the menu is looked at, and a change while it is open (a tool chosen with a key) shows at once.
 */
export function useMenuEntries(menuId: string, afterRun: () => void): readonly MenuEntry[] {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const structure = useShellStructure();
  const activeTool = useUi((ui) => ui.activeTool);
  const redactMode = useUi((ui) => ui.redactMode);
  const leftTab = useUi((ui) => ui.leftPanelTab);
  const docId = useDocuments(selectActiveId);
  const scrollMode = useDocViewValue(docId, (view) => view.scrollMode);
  const formHighlight = useForms((forms) => forms.highlight);
  const recents = useRecentItems();
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
          if (id === 'tool-select') return activeTool === 'select' && !redactMode;
          if (id === 'tool-redact') return redactMode;
          if (id.startsWith('tool-')) return activeTool === id.slice('tool-'.length) && !redactMode;
          if (id === 'toggle-left-panel') return !structure.leftCollapsed;
          if (id === 'toggle-inspector') return structure.inspectorVisible;
          if (id in TAB_OF) return leftTab === TAB_OF[id];
          if (id === 'form-highlight') return formHighlight;
          return undefined;
        },
        hasTextSelection: selection,
        recents,
      }),
    [
      menuId,
      t,
      platform,
      state,
      afterRun,
      scrollMode,
      activeTool,
      redactMode,
      structure.leftCollapsed,
      structure.inspectorVisible,
      leftTab,
      formHighlight,
      selection,
      recents,
    ],
  );
}
