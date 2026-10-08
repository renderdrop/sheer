import { History, Redo2, Search, Undo2, type LucideIcon } from 'lucide-react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { actionOf, actionShortcut, type ActionId } from '../../actions/registry';
import { IconButton } from '../../components';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { useToolInspector } from '../inspector/toolInspector';
import { useActionState } from '../shell/useActionState';

/** An icon button for a registry action: name, shortcut and enabled state come from the action. 32 high, icon 18. */
function ActionButton({ id, icon }: { id: ActionId; icon: LucideIcon }) {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const action = actionOf(id);
  const shortcut = actionShortcut(action, platform, t);
  return (
    <IconButton
      size="sm"
      className="size-8!"
      icon={icon}
      label={t(action.labelKey)}
      shortcut={shortcut?.label}
      keyShortcuts={shortcut?.aria}
      disabled={!action.enabled(state)}
      focusableWhenDisabled
      onClick={() => void runAction(id)}
    />
  );
}

/** History opens the F19.23 panel in the inspector slot; pressed while it is open. */
function HistoryButton() {
  const t = useT();
  const open = useToolInspector((state) => state.open === 'history');
  return (
    <IconButton
      size="sm"
      className="size-8!"
      icon={History}
      label={t('topbar.history')}
      pressed={open}
      onClick={() => useToolInspector.getState().toggleToolInspector('history')}
    />
  );
}

/**
 * The right cluster of the tab strip (DESIGN 3.18 E3): a full-height 1 px divider, then Undo, Redo and History (32, gap 2), a 1 x 20
 * divider and Search. The tour pill, the sidebar toggle and the zoom controls are gone from the top row.
 */
export function RightCluster() {
  return (
    <div className="flex shrink-0 items-center gap-[calc(var(--space-1)/2)] self-stretch border-s border-border-subtle ps-2 pe-3">
      <ActionButton id="undo" icon={Undo2} />
      <ActionButton id="redo" icon={Redo2} />
      <HistoryButton />
      <span aria-hidden="true" className="mx-2 h-5 w-px bg-(--color-border)" />
      <ActionButton id="find" icon={Search} />
    </div>
  );
}
