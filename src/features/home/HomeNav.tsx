import { Clock, Home, Settings, Star, Wrench, type LucideIcon } from 'lucide-react';

import { Icon } from '../../components';
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
  't-label flex h-control-md w-full cursor-pointer items-center gap-3 rounded-md px-3 text-start transition-colors [transition-duration:var(--motion-fast)] hover:bg-subtle active:bg-pressed';

/**
 * The navigation of Home (DESIGN v2 3.1): Canvas, 200 wide; the word mark in a 48 row, then the rows Home, Zuletzt, Markiert and
 * Werkzeuge (the active one Sand with Ink 600), and the Settings row at the bottom, 16 from its end. No Shared, no Trash (ADR-100).
 * The four rows are one tab stop; arrows move between them.
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
      className="flex w-(--home-nav-width) shrink-0 flex-col bg-app pb-4"
    >
      <div className="flex h-(--home-nav-row-height) items-center px-5 text-ink">
        <Wordmark className="h-6" />
      </div>
      <div {...roving.groupProps} className="mt-4 flex flex-col gap-1 px-3">
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
              className={cx(ROW, active && 'bg-subtle font-semibold text-ink')}
            >
              <Icon icon={row.icon} size={18} />
              {t(row.labelKey)}
            </button>
          );
        })}
      </div>
      <div className="mt-auto px-3">
        <button type="button" data-home-settings="" onClick={openSettings} className={ROW}>
          <Icon icon={Settings} size={18} />
          {t('home.nav.settings')}
        </button>
      </div>
    </nav>
  );
}
