import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { WindowHeading } from './WindowHeading';
import { CenterCluster } from './CenterCluster';
import { LeftCluster } from './LeftCluster';
import { LiveRegions } from './LiveRegions';
import { RightCluster } from './RightCluster';

export interface TopBarProps {
  /** macOS, not in full screen: the traffic lights float over the start of the bar. */
  trafficLightInset: boolean;
}

/**
 * The editor's top bar (DESIGN v2 3.2): 56 high, White, 1 px border below, grid `1fr auto 1fr`. Left: Back, the file name or the
 * tabs. Centre: zoom dropdown and page field. Right: Undo, Redo, Search, the tour pill, Fertig (the caption buttons are in the menu row).
 * Empty space is the drag region (Tauri's `data-tauri-drag-region`; buttons and fields are not).
 */
export function TopBar({ trafficLightInset }: TopBarProps) {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t('topbar.region')}
      data-slot="topbar"
      data-tauri-drag-region="deep"
      className={cx(
        'bg-panel grid h-topbar min-w-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border-subtle',
        trafficLightInset ? 'ps-chrome-inset' : 'ps-2',
      )}
    >
      <WindowHeading />
      <LeftCluster />
      <CenterCluster />
      <RightCluster />
      <LiveRegions />
    </div>
  );
}
