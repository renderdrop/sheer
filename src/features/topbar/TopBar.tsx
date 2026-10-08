import { ChevronLeft } from 'lucide-react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { actionOf, actionShortcut } from '../../actions/registry';
import { IconButton } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { TabStrip } from '../tabs/TabStrip';
import { LiveRegions } from './LiveRegions';
import { RightCluster } from './RightCluster';
import { WindowHeading } from './WindowHeading';

export interface TopBarProps {
  /** macOS, not in full screen: the traffic lights float over the start of the bar. */
  trafficLightInset: boolean;
}

/** Back to Home: 36, at x 4 (macOS: after the 80 inset), gap 4 to the tabs. */
function BackButton() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const home = actionOf('view-home');
  const shortcut = actionShortcut(home, platform, t);
  return (
    <IconButton
      icon={ChevronLeft}
      label={t(home.labelKey)}
      shortcut={shortcut?.label}
      keyShortcuts={shortcut?.aria}
      className="me-1 self-center"
      onClick={() => void runAction('view-home')}
    />
  );
}

/**
 * The editor's tab strip row (DESIGN 3.18 E3): 42 high, White, 1 px border below. Back, the document tabs (bottom-aligned, scrolling
 * from six), 24 px of drag space and the right cluster. Empty space is the drag region (Tauri's `data-tauri-drag-region`; buttons are not).
 */
export function TopBar({ trafficLightInset }: TopBarProps) {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t('topbar.region')}
      data-slot="tabstrip"
      data-tauri-drag-region="deep"
      className={cx(
        'bg-panel flex h-tabstrip min-w-0 items-end border-b border-border-subtle',
        trafficLightInset ? 'ps-chrome-inset' : 'ps-1',
      )}
    >
      <WindowHeading />
      <BackButton />
      <TabStrip />
      <span aria-hidden="true" className="w-6 shrink-0 self-stretch" />
      <RightCluster />
      <LiveRegions />
    </div>
  );
}
