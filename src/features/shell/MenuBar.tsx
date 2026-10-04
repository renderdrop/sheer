import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { MODAL_SELECTOR } from '../../actions/dispatch';
import { BAR_LABEL_KEY, barMenuSpecs } from '../../actions/menuModel';
import { Menu } from '../../components';
import { cx } from '../../components/cx';
import { isPlainKey, useT, type Translate } from '../../i18n';
import { useMenuEntries } from './useMenuEntries';

const ITEM_ATTRIBUTE = 'data-menubar-item';

/** The title with its access key letter underlined while Alt is held (the first match, case-insensitive). */
function Title({ label, access, show }: { label: string; access: string; show: boolean }): ReactNode {
  const at = access === '' ? -1 : label.toLowerCase().indexOf(access.toLowerCase());
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <span className={show ? 'underline' : undefined}>{label.charAt(at)}</span>
      {label.slice(at + 1)}
    </>
  );
}

function textOf(t: Translate, key: string): string {
  return isPlainKey(key) ? t(key) : key;
}

/** The entries function of a menu: a hook the menu calls while it is open. */
function entriesOf(id: string, afterRun: () => void) {
  return function useEntries() {
    return useMenuEntries(id, afterRun);
  };
}

/** One menu of the bar: its title button and the popover under it. The entries are built while it is open. */
function BarMenu({
  id,
  label,
  access,
  altHeld,
  open,
  setOpen,
  afterRun,
  register,
  onHover,
}: {
  id: string;
  label: string;
  access: string;
  altHeld: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  afterRun: () => void;
  register: (id: string, element: HTMLElement | null) => void;
  onHover: () => void;
}) {
  const entries = useMemo(() => entriesOf(id, afterRun), [id, afterRun]);
  return (
    <Menu
      label={label}
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      entries={entries}
      trigger={(trigger) => (
        <button
          {...trigger}
          ref={(element) => {
            trigger.ref(element);
            register(id, element);
          }}
          type="button"
          role="menuitem"
          tabIndex={-1}
          {...{ [ITEM_ATTRIBUTE]: id }}
          aria-keyshortcuts={`Alt+${access}`}
          onPointerEnter={onHover}
          className={cx(
            'h-control-sm shrink-0 cursor-default rounded-sm bg-transparent px-2 text-md text-inherit transition-colors',
            'hover:bg-control-hover aria-expanded:bg-control-pressed',
          )}
        >
          <Title label={label} access={access} show={altHeld} />
        </button>
      )}
    />
  );
}

/**
 * The Windows menu bar in the caption row (DESIGN 3.56): File, Edit, View, Tools, Help, rendered from `menu.json` and the registry.
 * `role=menubar`, not a Tab or F6 stop. Alt pressed and released alone, or F10, focuses the first title; Alt plus an access key opens
 * that menu (never with Ctrl, which is AltGr). In the bar Left and Right move (wrapping), Down, Enter and Space open; inside a menu Left
 * and Right open the neighbour; Esc closes the menu (focus on its title), a second Esc or Alt gives focus back to where it was.
 */
export function MenuBar() {
  const t = useT();
  const specs = barMenuSpecs();
  const [openId, setOpenId] = useState<string | null>(null);
  const [altHeld, setAltHeld] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const origin = useRef<HTMLElement | null>(null);
  const altAlone = useRef(false);
  const openRef = useRef<string | null>(null);
  useEffect(() => {
    openRef.current = openId;
  }, [openId]);

  const ids = specs.map((spec) => spec.id);
  const idKey = ids.join();

  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element === null) elements.current.delete(id);
    else elements.current.set(id, element);
  }, []);

  /** Remembers where focus was, unless it is in the bar already. */
  const remember = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && rootRef.current?.contains(active) !== true) {
      origin.current = active;
    }
  }, []);

  const restore = useCallback(() => {
    const target = origin.current;
    origin.current = null;
    if (target?.isConnected === true) target.focus({ preventScroll: true });
    else if (rootRef.current?.contains(document.activeElement) === true) {
      (document.activeElement as HTMLElement).blur();
    }
  }, []);

  const afterRun = useCallback(() => restore(), [restore]);

  const focusIndex = useCallback(
    (index: number) => {
      const id = ids[(index + ids.length) % ids.length];
      if (id !== undefined) elements.current.get(id)?.focus({ preventScroll: true });
    },
    // The ids are fixed by the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey],
  );

  const inBar = (): boolean => rootRef.current?.contains(document.activeElement) === true || openRef.current !== null;

  useEffect(() => {
    const modal = () => document.querySelector(MODAL_SELECTOR) !== null;
    const toggleFocus = () => {
      if (inBar()) {
        setOpenId(null);
        restore();
      } else {
        remember();
        focusIndex(0);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Alt') {
        if (!event.repeat) altAlone.current = !event.ctrlKey && !event.metaKey && !event.shiftKey;
        setAltHeld(true);
        return;
      }
      altAlone.current = false;
      if (modal()) return;
      if (event.key === 'F10' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        toggleFocus();
        return;
      }
      // Alt plus an access key opens that menu; Ctrl+Alt is AltGr and never does.
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key.length !== 1) return;
      const letter = event.key.toLowerCase();
      const index = specs.findIndex((spec) => textOf(t, spec.accessKey).toLowerCase() === letter);
      const spec = specs[index];
      if (spec === undefined) return;
      event.preventDefault();
      remember();
      elements.current.get(spec.id)?.focus({ preventScroll: true });
      setOpenId(spec.id);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      setAltHeld(false);
      if (!altAlone.current) return;
      altAlone.current = false;
      if (modal()) return;
      event.preventDefault();
      toggleFocus();
    };
    const onBlur = () => {
      altAlone.current = false;
      setAltHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // The titles change with the language only.
  }, [t, specs, remember, restore, focusIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    const target = event.target;
    if (!(target instanceof Node)) return;
    const item = target instanceof Element ? target.closest(`[${ITEM_ATTRIBUTE}]`) : null;
    const own = root.contains(target);
    const current = item === null ? -1 : ids.indexOf(item.getAttribute(ITEM_ATTRIBUTE) ?? '');

    if (!own) {
      // Inside a menu (the popover sits in a portal, but React events still bubble to the bar): the arrows open the neighbour.
      if (event.defaultPrevented || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      const index = ids.indexOf(openRef.current ?? '');
      if (index < 0) return;
      event.preventDefault();
      const next = ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
      if (next !== undefined) setOpenId(next);
      return;
    }
    if (current < 0) return;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusIndex(current + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusIndex(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        event.preventDefault();
        focusIndex(ids.length - 1);
        break;
      case 'Escape':
        // A menu that is open closed itself first (its own Esc); this one is the second.
        if (openRef.current === null) {
          event.preventDefault();
          restore();
        }
        break;
      default:
    }
  };

  return (
    <div
      ref={rootRef}
      role="menubar"
      aria-label={textOf(t, BAR_LABEL_KEY)}
      onKeyDown={onKeyDown}
      onPointerDownCapture={remember}
      onBlur={(event) => {
        // Focus left the bar for somewhere else (not into one of its menus): nothing to go back to.
        const next = event.relatedTarget;
        if (openRef.current === null && !(next instanceof Node && event.currentTarget.contains(next))) {
          if (!(next instanceof HTMLElement) || next.closest('[role="menu"]') === null) origin.current = null;
        }
      }}
      className="flex shrink-0 items-center"
    >
      {specs.map((spec) => (
        <BarMenu
          key={spec.id}
          id={spec.id}
          label={textOf(t, spec.labelKey)}
          access={textOf(t, spec.accessKey)}
          altHeld={altHeld}
          open={openId === spec.id}
          setOpen={(open) => setOpenId((current) => (open ? spec.id : current === spec.id ? null : current))}
          afterRun={afterRun}
          register={register}
          onHover={() => {
            if (openRef.current !== null && openRef.current !== spec.id) setOpenId(spec.id);
          }}
        />
      ))}
    </div>
  );
}
