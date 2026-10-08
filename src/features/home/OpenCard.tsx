import { FileText } from 'lucide-react';

import { Icon, SolarGlow } from '../../components';
import { useT } from '../../i18n';
import { ROVING_ATTR } from './roving';

export interface OpenCardProps {
  /** The id of the open document (the tab). */
  id: number;
  name: string;
  tabIndex: 0 | -1;
  onSwitch: (id: number) => void;
}

/**
 * A card of the "Open" section: the same form as a recent card (tile, name), for a tab that is open now. Click or Enter switches to
 * that tab. No star: a file that is open is not yet a recent-list entry to mark, and the card has no menu (the tab has its own).
 */
export function OpenCard({ id, name, tabIndex, onSwitch }: OpenCardProps) {
  const t = useT();
  const label = name === '' ? t('status.untitled') : name;
  return (
    <li
      data-open-card=""
      className="relative h-(--home-card-height) rounded-md border border-border-subtle bg-surface transition-colors [transition-duration:var(--motion-fast)] hover:bg-subtle focus-within:bg-subtle"
    >
      <button
        type="button"
        {...{ [ROVING_ATTR]: `open-${id}` }}
        tabIndex={tabIndex}
        aria-label={label}
        onClick={() => onSwitch(id)}
        className="flex size-full min-w-0 cursor-pointer items-center gap-3 rounded-md p-3 text-start"
      >
        <span
          data-recent-tile=""
          className="relative flex h-(--home-tile-height) w-(--home-tile-width) shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border-subtle bg-surface text-text-muted"
        >
          <SolarGlow variant="card" />
          <span className="relative">
            <Icon icon={FileText} size={18} />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="t-label truncate">{label}</span>
        </span>
      </button>
    </li>
  );
}
