import { Download, Ellipsis, Redo2, Search, Undo2, type LucideIcon } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { actionOf, actionShortcut, type ActionId } from '../../actions/registry';
import { Button, IconButton, Menu } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useActionState } from '../shell/useActionState';
import { TourPill } from '../tour/TourPill';
import { exportEntries, moreEntries } from './entries';
import { finishDocument } from './finish';
import { useActiveEdited } from './useEdited';

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

function ExportMenu() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const entries = useMemo(() => exportEntries({ t, platform, state }), [t, platform, state]);
  return (
    <Menu
      label={t('topbar.export')}
      side="bottom"
      align="end"
      entries={entries}
      trigger={(trigger) => (
        <IconButton
          {...trigger}
          icon={Download}
          label={t('topbar.export')}
          disabled={!state.hasDocument}
          focusableWhenDisabled
        />
      )}
    />
  );
}

function MoreMenu() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const state = useActionState();
  const entries = useMemo(() => moreEntries({ t, platform, state }), [t, platform, state]);
  return (
    <Menu
      label={t('topbar.more')}
      side="bottom"
      align="end"
      entries={entries}
      trigger={(trigger) => (
        <IconButton {...trigger} data-toolbar-item="more" icon={Ellipsis} label={t('topbar.more')} />
      )}
    />
  );
}

/** Fertig: saves (Save As for a document without a file), then goes back to Home. An Ink dot marks unsaved changes. */
function DoneButton() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const edited = useActiveEdited();
  return (
    <Button
      variant="primary"
      aria-description={edited ? t('status.edited') : undefined}
      onClick={() => void finishDocument(docId)}
    >
      {edited && (
        <span
          aria-hidden="true"
          data-edited=""
          className="size-[calc(var(--space-1)+var(--space-1)/2)] shrink-0 rounded-pill bg-text"
        />
      )}
      {t('topbar.done')}
    </Button>
  );
}

/** Right of the top bar: Undo, Redo, Search, Export, More, the tour pill, Fertig, and the caption buttons flush right. */
export function RightCluster({ captionControls }: { captionControls: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-end">
      <div className="flex items-center gap-1">
        <ActionButton id="undo" icon={Undo2} />
        <ActionButton id="redo" icon={Redo2} />
        <ActionButton id="find" icon={Search} />
        <ExportMenu />
        <MoreMenu />
      </div>
      <div className="flex items-center gap-3 ps-3 pe-2">
        <TourPill />
        <DoneButton />
      </div>
      {captionControls}
    </div>
  );
}
