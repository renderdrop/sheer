import { ChevronLeft } from 'lucide-react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { actionOf, actionShortcut } from '../../actions/registry';
import { IconButton } from '../../components';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { TabStrip } from '../tabs/TabStrip';
import { useActiveEdited } from './useEdited';

/** The one document's name with the unsaved dot before it; a double click is Save As. */
function FileTitle() {
  const t = useT();
  const name = useDocuments((state) => selectActiveDocument(state)?.displayName ?? null);
  const edited = useActiveEdited();
  if (name === null) return null;
  const shown = name === '' ? t('status.untitled') : name;
  return (
    <div
      className="flex min-w-0 max-w-[calc(var(--space-24)*2+var(--space-12)*2)] items-center gap-2 ps-2"
      onDoubleClick={() => void runAction('save-as')}
    >
      {edited && (
        <span
          aria-hidden="true"
          data-edited=""
          className="size-[calc(var(--space-1)+var(--space-1)/2)] shrink-0 rounded-pill bg-text"
        />
      )}
      {edited && <span className="sr-only">{t('status.edited')}</span>}
      <span data-tour-anchor="status-file-name" className="t-label min-w-0 truncate" title={shown}>
        {shown}
      </span>
    </div>
  );
}

/** Left of the top bar: Back to Home, then the file name, or the tabs with two or more documents. */
export function LeftCluster() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const count = useDocuments((state) => state.order.length);
  const home = actionOf('view-home');
  const shortcut = actionShortcut(home, platform, t);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <IconButton
        icon={ChevronLeft}
        label={t(home.labelKey)}
        shortcut={shortcut?.label}
        keyShortcuts={shortcut?.aria}
        onClick={() => void runAction('view-home')}
      />
      {count >= 2 ? <TabStrip /> : <FileTitle />}
    </div>
  );
}
