import { ArrowRightLeft, Ellipsis, X } from 'lucide-react';

import { IconButton, Menu, type MenuEntry } from '../../components';
import { useT } from '../../i18n';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { RecentThumb } from './RecentThumb';
import { ROVING_ATTR } from './roving';

export interface OpenCardProps {
  /** The id of the open document (the tab). */
  id: number;
  name: string;
  tabIndex: 0 | -1;
  onSwitch: (id: number) => void;
  onClose: (id: number) => void;
}

/**
 * A card of the "Open" row (DESIGN 3.18 H4): the same form as a recent card (thumbnail box, name, the ⋯ menu), for a tab that is open now.
 * Click or Enter switches to that tab; an unsaved document shows its Ink dot before the name. The menu offers Switch and Close tab.
 */
export function OpenCard({ id, name, tabIndex, onSwitch, onClose }: OpenCardProps) {
  const t = useT();
  const label = name === '' ? t('status.untitled') : name;
  const dirty = useAnnotations((state) => isDirty(state, id));
  const entries: MenuEntry[] = [
    { id: 'switch', label: t('home.open.switch'), icon: ArrowRightLeft, onSelect: () => onSwitch(id) },
    { id: 'close', label: t('home.open.close'), icon: X, onSelect: () => onClose(id) },
  ];
  return (
    <li
      data-open-card=""
      className="home-card group/card relative rounded-md border border-border-subtle bg-surface transition-colors [transition-duration:var(--motion-fast)] focus-within:bg-subtle hover:bg-subtle"
    >
      <button
        type="button"
        {...{ [ROVING_ATTR]: `open-${id}` }}
        tabIndex={tabIndex}
        aria-label={label}
        onClick={() => onSwitch(id)}
        className="home-card-body flex size-full min-w-0 cursor-pointer flex-col rounded-md text-start"
      >
        <RecentThumb id={null} />
        <span className="home-card-name t-nav flex min-w-0 items-center gap-2">
          {dirty && (
            <span aria-hidden="true" data-unsaved="" className="home-unsaved-dot shrink-0 rounded-pill bg-ink" />
          )}
          <span className="truncate">{label}</span>
        </span>
      </button>
      <span className="home-card-menu absolute">
        <Menu
          label={t('home.menu.label', { name: label })}
          align="end"
          entries={entries}
          trigger={(props) => (
            <IconButton
              {...props}
              size="sm"
              icon={Ellipsis}
              label={t('home.menu.label', { name: label })}
              tabIndex={-1}
            />
          )}
        />
      </span>
    </li>
  );
}
