import type { LucideIcon } from 'lucide-react';
import { Check, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { DISMISS_PRIORITY, registerDismissLayer } from './dismiss';
import { Icon } from './Icon';
import { PRESS_MOTION } from './controlStyles';
import { usePopoverMotion } from './motion';
import { ownedBy, PopoverScope } from './popoverScope';
import { POPOVER_WIDTHS, Popover, type PopoverProps } from './Popover';
import type { Side } from './position';
import { isOwnEvent, itemsOf, rovingTarget } from './roving';
import { overlayOffset } from './tokens';
import { useFloatingPosition } from './useFloatingPosition';

export interface MenuItemSpec {
  type?: 'item';
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Decorative element in the icon slot (for example a thumbnail); wins over `icon`. Must be `aria-hidden` or inert. */
  leading?: ReactNode;
  /** Shortcut as meta text, formatted for the platform. */
  shortcut?: string;
  /** Set for items with a checked state: shows a check and the accent text color; the role becomes `menuitemcheckbox`. */
  checked?: boolean;
  /** With `checked`: one of a group of exclusive choices, so the role is `menuitemradio`. */
  radio?: boolean;
  /** A second line under the label, Text-secondary (DESIGN 3.8 L2): the row grows to 48. */
  caption?: string;
  /** Stays focusable (`aria-disabled`, DESIGN 3.0) but does nothing. */
  disabled?: boolean;
  /**
   * Makes the item open a submenu with these entries (DESIGN 3.5) instead of running a command: it shows a chevron instead of
   * a shortcut, `aria-haspopup` and `aria-expanded`, and opens on Right, Enter, Space, a click or after a short hover. A
   * submenu may have submenus. `onSelect` is not called for such an item (give it a no-op).
   */
  submenu?: readonly MenuEntry[];
  onSelect: () => void;
}

export interface MenuSeparatorSpec {
  type: 'separator';
  id: string;
  /** A section header under the divider (DESIGN 3.58): not focusable, no divider when it is the first entry. */
  label?: string;
}

export type MenuEntry = MenuItemSpec | MenuSeparatorSpec;

/** How long typed characters count as one search word. */
const TYPEAHEAD_RESET = 500;

/**
 * Hover intent of a submenu, in ms. The pointer has to rest on the item this long before the submenu opens, so sweeping
 * down a menu does not flash every submenu in turn. Once open it stays for this long after the pointer left the item, so a
 * path that is not a straight line into the submenu (across a neighbour) does not close it; entering the submenu or going
 * back to the item cancels the closing.
 */
const SUBMENU_OPEN_DELAY = 200;
const SUBMENU_CLOSE_DELAY = 300;

const ITEM =
  'flex h-(--space-8) w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-start text-md ' +
  PRESS_MOTION +
  ' aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) ' +
  'not-aria-disabled:hover:bg-subtle not-aria-disabled:focus-visible:bg-subtle not-aria-disabled:active:bg-pressed not-aria-disabled:active:scale-(--scale-press) ' +
  'not-aria-disabled:aria-expanded:bg-subtle';
const ITEM_TALL = ITEM.replace('h-(--space-8)', 'h-(--space-12)');

/** The submenu that is open in a list: which item opened it, and how often focus was asked to go into it. */
interface OpenSubmenu {
  id: string;
  anchor: HTMLElement;
  focus: number;
}

interface TypedText {
  text: string;
  at: number;
}

/**
 * The item that the typed character selects, `undefined` when none matches. Characters typed in quick succession make one
 * word (`typed` remembers it); one repeated letter cycles through the items that start with it, a longer word stays on a match.
 */
function typeAhead(
  typed: TypedText,
  key: string,
  items: readonly HTMLElement[],
  current: number,
): HTMLElement | undefined {
  const now = Date.now();
  const word = (now - typed.at > TYPEAHEAD_RESET ? '' : typed.text) + key.toLowerCase();
  typed.text = word;
  typed.at = now;
  const from = word.length === 1 ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < items.length; step += 1) {
    const item = items[(from + step) % items.length];
    if (item?.dataset.label?.toLowerCase().startsWith(word)) return item;
  }
  return undefined;
}

/** The item (not separator) with this id. */
function itemById(entries: readonly MenuEntry[], id: string | undefined): MenuItemSpec | undefined {
  return entries.find((entry): entry is MenuItemSpec => entry.type !== 'separator' && entry.id === id);
}

interface MenuListProps {
  entries: readonly MenuEntry[];
  /** Called after an item was chosen, before its `onSelect`: the menu closes and gives focus back first. */
  onActivate: () => void;
  /** Tab inside a submenu: closes the whole menu (the surface of the menu itself handles Tab for the first level). */
  onTab?: () => void;
  /** Set on the list of a submenu: Left (Right in a right-to-left language) closes it and returns focus to its item. */
  onBack?: () => void;
}

/**
 * Items of a menu (DESIGN 3.5). Up and Down wrap, Home and End jump, typing a letter jumps to the next item starting with
 * it, Enter and Space choose. Right opens the submenu of an item that has one and puts focus on its first item, Left closes
 * a submenu again. The role `menu` and Esc, Tab and outside-click handling belong to the Popover around it.
 */
export function MenuList({ entries, onActivate, onTab, onBack }: MenuListProps) {
  const typed = useRef<TypedText>({ text: '', at: 0 });
  const baseId = useId();
  const present = useIsPresent();
  const [open, setOpen] = useState<OpenSubmenu | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const reserveIcon = entries.some(
    (entry) =>
      entry.type !== 'separator' &&
      (entry.icon !== undefined || entry.leading !== undefined || entry.checked !== undefined),
  );
  const hasSubmenus = entries.some((entry) => entry.type !== 'separator' && entry.submenu !== undefined);

  // A pending open or close of a submenu goes away with the list.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  // A list that is fading out (its menu closed) takes its submenu with it.
  const shown = present ? open : null;
  const shownItem = shown === null ? undefined : itemById(entries, shown.id);

  const stopTimer = () => window.clearTimeout(timer.current);
  const later = (action: () => void, delay: number) => {
    stopTimer();
    timer.current = window.setTimeout(action, delay);
  };
  const closeSubmenu = useCallback(() => setOpen(null), []);
  const openSubmenu = (item: MenuItemSpec, anchor: HTMLElement, focus: boolean) => {
    stopTimer();
    setOpen((current) => ({
      id: item.id,
      anchor,
      focus: (current?.id === item.id ? current.focus : 0) + (focus ? 1 : 0),
    }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (!isOwnEvent(list, event)) return;
    const items = itemsOf(list, '[role^="menuitem"]');
    const current = items.findIndex((item) => item === document.activeElement);
    const focused = items[current];

    const rtl = getComputedStyle(list).direction === 'rtl';
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
      if (focused?.getAttribute('aria-haspopup') !== 'menu') return;
      event.preventDefault();
      const item = itemById(entries, focused.dataset.id);
      if (item !== undefined && item.disabled !== true) openSubmenu(item, focused, true);
      return;
    }
    if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
      if (onBack === undefined) return;
      event.preventDefault();
      onBack();
      return;
    }

    const target = rovingTarget(event.key, current, items.length, { orientation: 'vertical', wrap: true });
    if (target !== null) {
      event.preventDefault();
      // Focus leaves the item that opened the submenu: the submenu is not the place to be any more.
      stopTimer();
      setOpen(null);
      items[target]?.focus();
      return;
    }

    if (event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.metaKey || event.altKey) return;
    const match = typeAhead(typed.current, event.key, items, current);
    if (match !== undefined) {
      event.preventDefault();
      stopTimer();
      setOpen(null);
      match.focus();
    }
  };

  /** The pointer came onto an item: it may open the submenu of this one (after a rest) or close the one of another. */
  const onItemEnter = (event: ReactPointerEvent<HTMLButtonElement>, item: MenuItemSpec) => {
    if (event.pointerType === 'touch') return; // touch has no hover: the tap that follows opens it
    const anchor = event.currentTarget;
    if (item.submenu !== undefined && item.disabled !== true) {
      if (shown?.id === item.id) stopTimer();
      else later(() => openSubmenu(item, anchor, false), SUBMENU_OPEN_DELAY);
    } else if (shown !== null) {
      later(closeSubmenu, SUBMENU_CLOSE_DELAY);
    } else {
      stopTimer();
    }
  };

  /** The pointer left an item with a submenu: a submenu that was about to open does not, one that is open closes later. */
  const onItemLeave = (event: ReactPointerEvent<HTMLButtonElement>, item: MenuItemSpec) => {
    if (event.pointerType === 'touch' || item.submenu === undefined) return;
    if (shown?.id === item.id) later(closeSubmenu, SUBMENU_CLOSE_DELAY);
    else stopTimer();
  };

  return (
    <>
      <div role="presentation" className="flex flex-col" onKeyDown={onKeyDown}>
        {entries.map((entry, index) => {
          if (entry.type === 'separator') {
            const line = <div role="separator" className="my-1 h-hairline bg-divider" />;
            if (entry.label === undefined) return <div key={entry.id}>{line}</div>;
            return (
              <div key={entry.id} role="presentation">
                {index > 0 && line}
                <div
                  role="presentation"
                  className="flex h-control-sm items-center px-2 text-sm font-semibold text-text-muted"
                >
                  {entry.label}
                </div>
              </div>
            );
          }
          const hasSubmenu = entry.submenu !== undefined;
          const onClick = (event: MouseEvent<HTMLButtonElement>) => {
            if (entry.disabled === true) {
              event.preventDefault();
              return;
            }
            if (hasSubmenu) {
              openSubmenu(entry, event.currentTarget, true);
              return;
            }
            onActivate();
            entry.onSelect();
          };
          return (
            <button
              key={entry.id}
              type="button"
              role={
                entry.checked === undefined ? 'menuitem' : entry.radio === true ? 'menuitemradio' : 'menuitemcheckbox'
              }
              aria-checked={entry.checked}
              aria-disabled={entry.disabled === true ? true : undefined}
              aria-haspopup={hasSubmenu ? 'menu' : undefined}
              aria-expanded={hasSubmenu ? shown?.id === entry.id : undefined}
              aria-controls={hasSubmenu && shown?.id === entry.id ? `${baseId}${entry.id}` : undefined}
              tabIndex={-1}
              data-id={entry.id}
              data-label={entry.label}
              onClick={onClick}
              onPointerEnter={(event) => onItemEnter(event, entry)}
              onPointerLeave={(event) => onItemLeave(event, entry)}
              className={`${entry.caption === undefined ? ITEM : ITEM_TALL} text-text`}
            >
              {reserveIcon &&
                (entry.checked === true ? (
                  <Icon icon={Check} />
                ) : entry.leading !== undefined ? (
                  entry.leading
                ) : entry.icon !== undefined ? (
                  <Icon icon={entry.icon} />
                ) : (
                  <span aria-hidden="true" className="size-icon-16 shrink-0" />
                ))}
              {entry.caption === undefined ? (
                <span className="flex-auto truncate">{entry.label}</span>
              ) : (
                <span className="flex min-w-0 flex-auto flex-col">
                  <span className="t-label truncate">{entry.label}</span>
                  <span className="t-caption truncate text-text-muted">{entry.caption}</span>
                </span>
              )}
              {hasSubmenu ? (
                <Icon icon={ChevronRight} className="text-text-muted rtl:-scale-x-100" />
              ) : (
                entry.shortcut !== undefined && <span className="shrink-0 t-caption">{entry.shortcut}</span>
              )}
            </button>
          );
        })}
      </div>
      {hasSubmenus &&
        createPortal(
          <AnimatePresence>
            {shown !== null && shownItem?.submenu !== undefined && (
              <SubmenuSurface
                key={shown.id}
                id={`${baseId}${shown.id}`}
                label={shownItem.label}
                anchor={shown.anchor}
                focus={shown.focus}
                entries={shownItem.submenu}
                onActivate={onActivate}
                onTab={onTab ?? onActivate}
                onClose={closeSubmenu}
                onPointerEnter={stopTimer}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

interface SubmenuSurfaceProps {
  id: string;
  label: string;
  /** The item that opened it. */
  anchor: HTMLElement;
  /** Focus goes to the first item whenever this grows. */
  focus: number;
  entries: readonly MenuEntry[];
  onActivate: () => void;
  onTab: () => void;
  onClose: () => void;
  onPointerEnter: () => void;
}

/**
 * A submenu (DESIGN 3.5): solid (glass is never nested in glass), beside the item that opened it on the side where it fits,
 * its first item level with that item. Esc closes it and returns focus to the item; the next Esc closes the menu. It belongs
 * to the popover around its menu although it sits in a portal (a click on it is no outside click).
 */
function SubmenuSurface({
  id,
  label,
  anchor,
  focus,
  entries,
  onActivate,
  onTab,
  onClose,
  onPointerEnter,
}: SubmenuSurfaceProps) {
  const positioner = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  const owner = useContext(PopoverScope);
  // Beside the item, away from the end of the text: on the left in a right-to-left language. It overlaps the panel of its
  // parent (offset 0), so the pointer has no gap to cross, and its first item lines up with the parent item (the padding of
  // the panel, `--space-2`, is taken off).
  const [side] = useState<Side>(() => (getComputedStyle(anchor).direction === 'rtl' ? 'left' : 'right'));
  const crossOffset = useMemo(() => -overlayOffset(), []);
  useFloatingPosition({
    anchor,
    floatingRef: positioner,
    active: present,
    side,
    align: 'start',
    offset: 0,
    crossOffset,
  });

  const back = useCallback(() => {
    anchor.focus({ preventScroll: true });
    onClose();
  }, [anchor, onClose]);

  // Keyboard open: focus goes to the first item. Pointer open leaves focus where it is.
  useLayoutEffect(() => {
    const element = surface.current;
    if (focus === 0 || element === null) return;
    (itemsOf(element, '[role^="menuitem"]')[0] ?? element).focus({ preventScroll: true });
  }, [focus]);

  // A submenu that closes while focus is inside it (the pointer moved on) gives focus to its item, not to the page.
  useLayoutEffect(() => {
    if (present) return;
    const active = document.activeElement;
    if (active !== null && surface.current?.contains(active) === true) anchor.focus({ preventScroll: true });
  }, [present, anchor]);

  // Esc closes the innermost submenu first (it registered last), then the menu.
  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.popover, back);
  }, [present, back]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab' && isOwnEvent(event.currentTarget, event)) onTab();
  };

  return (
    <div
      ref={positioner}
      {...ownedBy(owner)}
      onPointerEnter={onPointerEnter}
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...motionProps}
        ref={surface}
        id={id}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ transformOrigin: side === 'left' ? 'right top' : 'left top' }}
        className={`bg-panel border border-border-subtle shadow-floating min-h-0 overflow-auto rounded-button p-1 text-md text-text outline-none ${POPOVER_WIDTHS}`}
      >
        <MenuList entries={entries} onActivate={onActivate} onTab={onTab} onBack={back} />
      </motion.div>
    </div>
  );
}

/**
 * The entries of a menu: a list, or a function that makes the list while the menu renders. The function runs only while the
 * menu is open and may use hooks, so the menu follows state of its own (the zoom menu's checked preset) without the parent
 * having to re-render to hand over a new list. It must call the same hooks on every call.
 */
export type MenuEntries = readonly MenuEntry[] | (() => readonly MenuEntry[]);

export interface MenuProps extends Omit<PopoverProps, 'role' | 'children'> {
  entries: MenuEntries;
}

/** Resolves `MenuEntries`, so a hook inside the function belongs to this component and not to the popover around it. */
function MenuBody({ entries, onActivate, onTab }: { entries: MenuEntries; onActivate: () => void; onTab: () => void }) {
  return (
    <MenuList entries={typeof entries === 'function' ? entries() : entries} onActivate={onActivate} onTab={onTab} />
  );
}

/** A Popover with role `menu` and a list of commands (DESIGN 3.5). */
export function Menu({ entries, ...popover }: MenuProps) {
  return (
    <Popover {...popover} role="menu">
      {({ close }) => <MenuBody entries={entries} onActivate={() => close('select')} onTab={() => close('tab')} />}
    </Popover>
  );
}
