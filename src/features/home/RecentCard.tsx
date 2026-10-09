import { Ellipsis, ExternalLink, FolderOpen, Star, Trash2 } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import type { Platform } from '../../api/app';
import type { RecentEntry } from '../../api/recents';
import { Icon, IconButton, Menu, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { useLocale, useT } from '../../i18n';
import { RecentThumb } from './RecentThumb';
import { ROVING_ATTR } from './roving';
import { formatAge } from './recents';

export interface RecentCardProps {
  entry: RecentEntry;
  now: number;
  platform: Platform | null;
  tabIndex: 0 | -1;
  onOpen: (entry: RecentEntry, tile: Element | null) => void;
  onToggleStar: (entry: RecentEntry) => void;
  onReveal: (entry: RecentEntry) => void;
  onRemove: (entry: RecentEntry) => void;
}

/** Opens the ⋯ menu of the card that `from` belongs to (its trigger is not a tab stop). */
function openCardMenu(from: HTMLElement): void {
  from.parentElement?.querySelector<HTMLElement>('[data-card-menu]')?.click();
}

/**
 * A document card (DESIGN 3.18 H4): White, subtle border, radius md; thumbnail box, name and the ⋯ menu. Hover or focus
 * inside turns it Sand and shows the star; a marked card is tinted `--card-starred` with its filled star always. The card is one roving item:
 * Enter opens, Delete takes it off the list, the Menu key or Shift+F10 opens its menu.
 */
export function RecentCard({
  entry,
  now,
  platform,
  tabIndex,
  onOpen,
  onToggleStar,
  onReveal,
  onRemove,
}: RecentCardProps) {
  const t = useT();
  const locale = useLocale();
  const name = entry.displayName === '' ? t('status.untitled') : entry.displayName;
  const age = entry.missing ? t('emptyState.recentMissing') : formatAge(entry.lastOpened, now, locale);
  const id = String(entry.id);

  const entries: MenuEntry[] = [
    {
      id: 'open',
      label: t('home.menu.open'),
      icon: FolderOpen,
      disabled: entry.missing,
      onSelect: () => onOpen(entry, null),
    },
    {
      id: 'star',
      label: entry.starred ? t('home.menu.unstar') : t('home.menu.star'),
      icon: Star,
      onSelect: () => onToggleStar(entry),
    },
    {
      id: 'reveal',
      label: platform === 'macos' ? t('home.menu.revealMac') : t('home.menu.revealWin'),
      icon: ExternalLink,
      disabled: entry.missing,
      onSelect: () => onReveal(entry),
    },
    { id: 'sep', type: 'separator' },
    { id: 'remove', label: t('home.menu.remove'), icon: Trash2, onSelect: () => onRemove(entry) },
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Delete') {
      event.preventDefault();
      onRemove(entry);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openCardMenu(event.currentTarget);
    }
  };

  // The star shows on hover and focus inside (and while the menu is open); a marked card shows its filled star always.
  const reveal = 'group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-aria-expanded:opacity-100';

  return (
    <li
      data-recent-card=""
      data-starred={entry.starred || undefined}
      className={cx(
        'home-card group/card relative rounded-md border border-border-subtle transition-colors [transition-duration:var(--motion-fast)] focus-within:bg-subtle hover:bg-subtle',
        entry.starred ? 'bg-(--card-starred)' : 'bg-surface',
        entry.missing && 'opacity-60',
      )}
    >
      <button
        type="button"
        {...{ [ROVING_ATTR]: id }}
        data-recent-open=""
        tabIndex={tabIndex}
        aria-disabled={entry.missing || undefined}
        aria-label={age === '' ? name : `${name}, ${age}`}
        onClick={(event) => onOpen(entry, event.currentTarget.querySelector('[data-recent-tile]'))}
        onContextMenu={(event) => {
          event.preventDefault();
          openCardMenu(event.currentTarget);
        }}
        onKeyDown={onKeyDown}
        className={cx(
          'home-card-body flex size-full min-w-0 cursor-pointer flex-col rounded-md text-start',
          entry.missing && 'cursor-not-allowed',
        )}
      >
        <RecentThumb id={entry.id} missing={entry.missing} />
        <span className="home-card-name t-nav min-w-0">
          <span className="home-card-name-text min-w-0 truncate">{name}</span>
        </span>
      </button>
      <span
        className={cx(
          'home-card-star absolute transition-opacity',
          entry.starred ? 'opacity-100' : `opacity-0 ${reveal}`,
        )}
      >
        <IconButton
          size="sm"
          label={entry.starred ? t('home.menu.unstar') : t('home.menu.star')}
          pressed={entry.starred}
          tabIndex={-1}
          onClick={() => onToggleStar(entry)}
        >
          <Icon icon={Star} size={20} className={cx('text-ink', entry.starred && 'fill-(--star-fill)')} />
        </IconButton>
      </span>
      <span className="home-card-menu absolute">
        <Menu
          label={t('home.menu.label', { name })}
          align="end"
          entries={entries}
          trigger={(props) => (
            <IconButton
              {...props}
              data-card-menu=""
              size="sm"
              icon={Ellipsis}
              label={t('home.menu.label', { name })}
              tabIndex={-1}
            />
          )}
        />
      </span>
    </li>
  );
}
