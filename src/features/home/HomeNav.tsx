import { Clock, Home, Settings, Star, Wrench, type LucideIcon } from 'lucide-react';

import { Icon, Tooltip } from '../../components';
import { Wordmark } from '../../components/Wordmark';
import { cx } from '../../components/cx';
import { useT, type PlainKey } from '../../i18n';
import { openSettings } from '../settings/state';
import { ROVING_ATTR, useRovingGroup } from './roving';

export type HomeSection = 'home' | 'recent' | 'starred' | 'tools';

const ROWS: readonly { id: HomeSection; icon: LucideIcon; labelKey: PlainKey }[] = [
  { id: 'home', icon: Home, labelKey: 'home.nav.home' },
  { id: 'recent', icon: Clock, labelKey: 'home.nav.recent' },
  { id: 'starred', icon: Star, labelKey: 'home.nav.starred' },
  { id: 'tools', icon: Wrench, labelKey: 'home.nav.tools' },
];

const ROW =
  't-nav flex h-(--home-nav-row-height) w-full cursor-pointer items-center gap-5 rounded-md px-6 text-start transition-colors [transition-duration:var(--motion-fast)] hover:bg-subtle active:bg-pressed';

/**
 * The navigation of Home (DESIGN 3.18 H2): Canvas, 230 wide; the word mark 32 high at x 40, top 80; the rows Start, Zuletzt, Markiert and
 * Werkzeuge from top 144 (44 high, gap 4, the active one Sand with Ink 500 and `aria-current`), and the Settings button at the bottom
 * (x 36, bottom 48, 40 high, bordered). No Shared, no Trash (ADR-100). The four rows are one tab stop; arrows move between them.
 */
export function HomeNav({ section, onSection }: { section: HomeSection; onSection: (section: HomeSection) => void }) {
  const t = useT();
  const roving = useRovingGroup(
    ROWS.map((row) => row.id),
    true,
  );
  return (
    <nav
      aria-label={t('home.nav.label')}
      data-home-nav=""
      className="home-nav flex w-(--home-nav-width) shrink-0 flex-col bg-app"
    >
      <div className="home-wordmark text-ink">
        <Wordmark className="h-full w-auto" />
      </div>
      <div {...roving.groupProps} className="home-nav-rows flex flex-col gap-1">
        {ROWS.map((row) => {
          const active = row.id === section;
          return (
            <button
              key={row.id}
              type="button"
              {...{ [ROVING_ATTR]: row.id }}
              tabIndex={roving.tabIndexOf(row.id)}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSection(row.id)}
              className={cx(ROW, active && 'bg-subtle font-medium text-ink')}
            >
              <Icon icon={row.icon} size={20} />
              {t(row.labelKey)}
            </button>
          );
        })}
      </div>
      <div className="home-settings mt-auto">
        <Tooltip label={t('home.nav.settings')} side="right">
          <button
            type="button"
            data-home-settings=""
            aria-label={t('home.nav.settings')}
            onClick={openSettings}
            className="flex h-control-lg items-center justify-center rounded-md border border-border-subtle px-3 text-ink transition-colors [transition-duration:var(--motion-fast)] hover:bg-subtle active:bg-pressed"
          >
            <Icon icon={Settings} size={20} />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
