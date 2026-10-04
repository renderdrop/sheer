import { Redo2, Search, Undo2, type LucideIcon } from 'lucide-react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { actionOf, actionShortcut, type ActionId } from '../../actions/registry';
import { IconButton } from '../../components';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { useActionState } from '../shell/useActionState';
import { TourPill } from '../tour/TourPill';

/** An icon button for a registry action: name, shortcut and enabled state come from the action. */
function ActionButton({ id, icon }: { id: ActionId; icon: LucideIcon }) {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const action = actionOf(id);
  const shortcut = actionShortcut(action, platform, t);
  return (
    <IconButton
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

/** Right of the top bar: Undo, Redo, Search, and the tour pill. Datei and Ansicht hold what Export and More used to. */
export function RightCluster() {
  return (
    <div className="flex min-w-0 items-center justify-end">
      <div className="flex items-center gap-1">
        <ActionButton id="undo" icon={Undo2} />
        <ActionButton id="redo" icon={Redo2} />
        <ActionButton id="find" icon={Search} />
      </div>
      <div className="flex items-center gap-3 ps-3 pe-4">
        <TourPill />
      </div>
    </div>
  );
}
