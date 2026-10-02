import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import { useRef, type KeyboardEvent, type MouseEvent } from 'react';

import { Icon } from './Icon';
import { Popover, type PopoverProps } from './Popover';
import { isOwnEvent, itemsOf, rovingTarget } from './roving';

export interface MenuItemSpec {
  type?: 'item';
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Shortcut as meta text, formatted for the platform. */
  shortcut?: string;
  /** Set for items with a checked state: shows a check and the accent text color; the role becomes `menuitemcheckbox`. */
  checked?: boolean;
  /** Stays focusable (`aria-disabled`, DESIGN 3.0) but does nothing. */
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparatorSpec {
  type: 'separator';
  id: string;
}

export type MenuEntry = MenuItemSpec | MenuSeparatorSpec;

/** How long typed characters count as one search word. */
const TYPEAHEAD_RESET = 500;

const ITEM =
  'flex h-control-md w-full cursor-pointer items-center gap-1 rounded-sm px-1 text-start text-md ' +
  'transition-[background-color,color] aria-disabled:cursor-not-allowed aria-disabled:text-text-disabled ' +
  'not-aria-disabled:hover:bg-control-hover not-aria-disabled:focus-visible:bg-control-hover not-aria-disabled:active:bg-control-pressed';

interface MenuListProps {
  entries: readonly MenuEntry[];
  /** Called after an item was chosen, before its `onSelect`: the menu closes and gives focus back first. */
  onActivate: () => void;
}

/**
 * Items of a menu (DESIGN 3.5). Up and Down wrap, Home and End jump, typing a letter jumps to the next item starting with
 * it, Enter and Space choose. The role `menu` and Esc, Tab and outside-click handling belong to the Popover around it.
 */
export function MenuList({ entries, onActivate }: MenuListProps) {
  const typed = useRef({ text: '', at: 0 });
  const reserveIcon = entries.some(
    (entry) => entry.type !== 'separator' && (entry.icon !== undefined || entry.checked !== undefined),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (!isOwnEvent(list, event)) return;
    const items = itemsOf(list, '[role^="menuitem"]');
    const current = items.findIndex((item) => item === document.activeElement);

    const target = rovingTarget(event.key, current, items.length, { orientation: 'vertical', wrap: true });
    if (target !== null) {
      event.preventDefault();
      items[target]?.focus();
      return;
    }

    if (event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = Date.now();
    const word = (now - typed.current.at > TYPEAHEAD_RESET ? '' : typed.current.text) + event.key.toLowerCase();
    typed.current = { text: word, at: now };
    // One repeated letter cycles through the items that start with it; a longer word stays on a match.
    const from = word.length === 1 ? current + 1 : Math.max(current, 0);
    for (let step = 0; step < items.length; step += 1) {
      const item = items[(from + step) % items.length];
      if (item?.dataset.label?.toLowerCase().startsWith(word)) {
        event.preventDefault();
        item.focus();
        return;
      }
    }
  };

  return (
    <div role="presentation" className="flex flex-col" onKeyDown={onKeyDown}>
      {entries.map((entry) => {
        if (entry.type === 'separator') {
          return <div key={entry.id} role="separator" className="my-0-5 h-hairline bg-divider" />;
        }
        const onClick = (event: MouseEvent<HTMLButtonElement>) => {
          if (entry.disabled === true) {
            event.preventDefault();
            return;
          }
          onActivate();
          entry.onSelect();
        };
        return (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            aria-disabled={entry.disabled === true ? true : undefined}
            tabIndex={-1}
            data-label={entry.label}
            onClick={onClick}
            className={`${ITEM} ${entry.checked === true ? 'text-text-accent' : 'text-text'}`}
          >
            {reserveIcon &&
              (entry.checked === true ? (
                <Icon icon={Check} />
              ) : entry.icon !== undefined ? (
                <Icon icon={entry.icon} />
              ) : (
                <span aria-hidden="true" className="size-icon-16 shrink-0" />
              ))}
            <span className="flex-auto truncate">{entry.label}</span>
            {entry.shortcut !== undefined && <span className="shrink-0 text-sm text-text-muted">{entry.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface MenuProps extends Omit<PopoverProps, 'role' | 'children'> {
  entries: readonly MenuEntry[];
}

/** A Popover with role `menu` and a list of commands (DESIGN 3.5). */
export function Menu({ entries, ...popover }: MenuProps) {
  return (
    <Popover {...popover} role="menu">
      {({ close }) => <MenuList entries={entries} onActivate={() => close('select')} />}
    </Popover>
  );
}
