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
 * A document card (DESIGN v2 3.1): White, subtle border, radius md, 76 high; thumbnail tile, name and relative time. Hover or focus
 * inside turns it Sand and shows the star and the menu; a marked card shows its filled star always. The card is one roving item:
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

  // The actions show on hover and focus inside, while the menu is open, and always for the star of a marked card.
  const reveal = 'group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-aria-expanded:opacity-100';

  return (
    <li
      data-recent-card=""
      className="group/card relative h-(--home-card-height) rounded-md border border-border-subtle bg-surface transition-colors [transition-duration:var(--motion-fast)] hover:bg-subtle focus-within:bg-subtle"
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
          'flex size-full min-w-0 cursor-pointer items-center gap-3 rounded-md p-3 text-start',
          'group-hover/card:pe-(--home-actions-clear) group-focus-within/card:pe-(--home-actions-clear)',
          entry.missing && 'cursor-not-allowed',
        )}
      >
        <RecentThumb id={entry.id} missing={entry.missing} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="t-label truncate">{name}</span>
          <span className="t-caption truncate">{age}</span>
        </span>
      </button>
      <div className="absolute inset-y-0 end-3 flex items-center gap-1">
        <span className={cx('transition-opacity', entry.starred ? 'opacity-100' : `opacity-0 ${reveal}`)}>
          <IconButton
            size="sm"
            label={entry.starred ? t('home.menu.unstar') : t('home.menu.star')}
            pressed={entry.starred}
            tabIndex={-1}
            onClick={() => onToggleStar(entry)}
          >
            <Icon icon={Star} size={16} className={cx(entry.starred && 'fill-current')} />
          </IconButton>
        </span>
        <span className={cx('opacity-0 transition-opacity', reveal)}>
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
      </div>
    </li>
  );
}
