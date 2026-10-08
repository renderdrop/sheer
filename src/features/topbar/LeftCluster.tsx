import { useEffect, useState } from 'react';
import { ChevronLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { actionOf, actionShortcut } from '../../actions/registry';
import { Icon, IconButton } from '../../components';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useSettings } from '../../stores/settings';
import { LEFT_PANEL_ID } from '../shell/ids';
import { readShellStructure } from '../shell/useShellStructure';
import { TabStrip } from '../tabs/TabStrip';
import { SaveStatus } from './SaveStatus';

/** The one document's name (the unsaved state is the save status beside it); a double click is Save As. */
function FileTitle() {
  const t = useT();
  const name = useDocuments((state) => selectActiveDocument(state)?.displayName ?? null);
  if (name === null) return null;
  const shown = name === '' ? t('status.untitled') : name;
  return (
    <div
      className="flex min-w-0 max-w-[calc(var(--space-24)*2+var(--space-12)*2)] items-center gap-2 ps-2"
      onDoubleClick={() => void runAction('save-as')}
    >
      <span data-tour-anchor="topbar-file-name" className="t-label min-w-0 truncate" title={shown}>
        {shown}
      </span>
    </div>
  );
}

/** Re-renders on a window resize, which can collapse the sidebar without a click. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** The two glyphs of the toggle on top of each other: the one for the state fades in, the other out (MOTION spell 14, fast). */
export function ToggleGlyphs({ open }: { open: boolean }) {
  const layer = 'col-start-1 row-start-1 transition-opacity duration-fast ease-out';
  return (
    <span aria-hidden="true" data-toggle-glyphs={open ? 'close' : 'open'} className="grid place-items-center">
      <span className={`${layer} ${open ? 'opacity-100' : 'opacity-0'}`}>
        <Icon icon={PanelLeftClose} size={18} />
      </span>
      <span className={`${layer} ${open ? 'opacity-0' : 'opacity-100'}`}>
        <Icon icon={PanelLeftOpen} size={18} />
      </span>
    </span>
  );
}

/** The page sidebar toggle (DESIGN 3.5 B2): the same action as View > Sidebar and the splitter grip, pressed while the sidebar is open. */
function SidebarToggle() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  // Read from the stores (not the shell's hook, whose calls count the shell's renders); a resize can collapse it by itself.
  useWindowWidth();
  const open = !useUi(() => readShellStructure().leftCollapsed);
  const action = actionOf('toggle-left-panel');
  const shortcut = actionShortcut(action, platform, t);
  return (
    <IconButton
      label={t(open ? 'sidebar.hide' : 'sidebar.show')}
      shortcut={shortcut?.label}
      keyShortcuts={shortcut?.aria}
      pressed={open}
      aria-controls={open ? LEFT_PANEL_ID : undefined}
      data-sidebar-toggle=""
      onClick={() => void runAction('toggle-left-panel')}
    >
      <ToggleGlyphs open={open} />
    </IconButton>
  );
}

/** Left of the top bar: Back to Home, the sidebar toggle, then the file name (or the tabs with two or more documents) and the save status. */
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
      <SidebarToggle />
      {count >= 2 ? <TabStrip /> : <FileTitle />}
      <SaveStatus />
    </div>
  );
}
