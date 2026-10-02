import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';

import { DISMISS_PRIORITY, registerDismissLayer } from './dismiss';
import { cycleTab, TAB_STOPS } from './focusTrap';
import { useControllableState } from './hooks';
import { usePopoverMotion } from './motion';
import { isInsideOwned, PopoverScope } from './popoverScope';
import type { Align, Side } from './position';
import { isOwnEvent, itemsOf } from './roving';
import { useFloatingPosition } from './useFloatingPosition';

/** Why a popover closed. Decides where focus goes. */
export type PopoverCloseReason = 'escape' | 'outside' | 'select' | 'tab' | 'toggle' | 'other' | 'programmatic';

export interface PopoverApi {
  close: (reason?: PopoverCloseReason) => void;
}

/** What the trigger element needs. Spread it onto a Button, IconButton or any element that takes a ref. */
export interface PopoverTriggerProps {
  ref: RefCallback<HTMLElement>;
  'aria-haspopup': 'dialog' | 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface PopoverProps {
  /** Renders the trigger with the props that wire it up: `trigger={(props) => <Button {...props}>Open</Button>}`. */
  trigger: (props: PopoverTriggerProps) => ReactElement;
  /** Accessible name of the popover. */
  label: string;
  /** `dialog` (default): Tab cycles inside. `menu`: arrow keys between items (see Menu), Tab closes. */
  role?: 'dialog' | 'menu';
  /**
   * The trigger is disabled: it neither opens the popover nor reacts to Enter, Space or the arrow keys, and an open
   * popover closes. Set it whenever the trigger is `aria-disabled` (a soft-disabled control still receives events).
   */
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Default `bottom`, aligned to the start of the trigger. Flips when it does not fit (DESIGN 3.5). */
  side?: Side;
  align?: Align;
  children: ReactNode | ((api: PopoverApi) => ReactNode);
}

type FocusRequest = 'first' | 'last' | 'auto';

/** The one open popover (DESIGN 3.5: one open at a time). Opening another closes it without moving focus. */
const group: { current: { id: string; close: (reason: PopoverCloseReason) => void } | null } = { current: null };

/**
 * G2 popover (DESIGN 3.5): opens from a trigger, takes focus, closes on Esc and outside click, and returns focus to
 * the trigger. Esc is seen only when no tooltip is open. Roles: `dialog` for panels with controls, `menu` for lists of
 * commands (use Menu). Keys on a menu trigger: Enter, Space and ArrowDown open it on the first item, ArrowUp on the last.
 */
export function Popover({
  trigger,
  label,
  role = 'dialog',
  disabled = false,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  side = 'bottom',
  align = 'start',
  children,
}: PopoverProps) {
  const id = useId();
  const [open, setOpen] = useControllableState(openProp, defaultOpen, onOpenChange);
  // The trigger element lives in state (set through its ref), so rendering never has to read a ref.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>('auto');

  const close = useCallback(
    (reason: PopoverCloseReason = 'programmatic') => {
      setOpen(false);
      if (reason === 'other' || anchor === null) return;
      if (reason === 'outside') {
        // The click may have focused something else; only a click on nothing focusable returns focus to the trigger.
        window.setTimeout(() => {
          const active = document.activeElement;
          if (active === null || active === document.body) anchor.focus({ preventScroll: true });
        }, 0);
      } else {
        anchor.focus({ preventScroll: true });
      }
    },
    [setOpen, anchor],
  );

  // One open at a time, whether it was opened here or by the parent through `open`.
  useEffect(() => {
    if (!open) return;
    if (group.current !== null && group.current.id !== id) group.current.close('other');
    group.current = { id, close };
    return () => {
      if (group.current?.id === id) group.current = null;
    };
  }, [open, id, close]);

  // A trigger that becomes disabled takes its popover with it.
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);

  const openWith = (request: FocusRequest) => {
    setFocusRequest(request);
    setOpen(true);
  };

  const triggerProps: PopoverTriggerProps = {
    ref: setAnchor,
    'aria-haspopup': role,
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: () => {
      if (disabled) return;
      if (open) close('toggle');
      else openWith(role === 'menu' ? 'first' : 'auto');
    },
    onKeyDown: (event) => {
      if (disabled || role !== 'menu' || event.target !== event.currentTarget) return;
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (open) close('toggle');
        else openWith('first');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openWith('last');
      }
    },
  };

  return (
    <>
      {trigger(triggerProps)}
      {createPortal(
        <AnimatePresence>
          {open && (
            <Surface
              key="popover"
              id={id}
              label={label}
              role={role}
              anchor={anchor}
              side={side}
              align={align}
              focusRequest={focusRequest}
              onClose={close}
            >
              {typeof children === 'function' ? children({ close }) : children}
            </Surface>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

interface SurfaceProps {
  id: string;
  label: string;
  role: 'dialog' | 'menu';
  anchor: HTMLElement | null;
  side: Side;
  align: Align;
  focusRequest: FocusRequest;
  onClose: (reason: PopoverCloseReason) => void;
  children: ReactNode;
}

// 200 to 320 px wide (DESIGN 3.5): `--popover-min` and `--popover-max`. A submenu has the same width.
export const POPOVER_WIDTHS = 'min-w-popover-min max-w-popover-max';

/** Where the entrance scales from: the corner nearest the trigger. */
function originOf(side: Side, align: Align): string {
  const horizontal = align === 'end' ? 'right' : align === 'center' ? 'center' : 'left';
  const vertical = align === 'end' ? 'bottom' : align === 'center' ? 'center' : 'top';
  switch (side) {
    case 'bottom':
      return `${horizontal} top`;
    case 'top':
      return `${horizontal} bottom`;
    case 'right':
      return `left ${vertical}`;
    case 'left':
      return `right ${vertical}`;
  }
}

function Surface({ id, label, role, anchor, side, align, focusRequest, onClose, children }: SurfaceProps) {
  const positioner = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  useFloatingPosition({ anchor, floatingRef: positioner, active: present, side, align });

  // Initial focus: the first or last menu item, the first control of a dialog, else the popover itself.
  useLayoutEffect(() => {
    const element = surface.current;
    if (element === null) return;
    let target: HTMLElement | null | undefined;
    if (role === 'menu') {
      const items = itemsOf(element, '[role^="menuitem"]');
      target = focusRequest === 'last' ? items.at(-1) : items[0];
    } else {
      target = element.querySelector<HTMLElement>('[data-autofocus]') ?? itemsOf(element, TAB_STOPS)[0];
    }
    (target ?? element).focus({ preventScroll: true });
  }, [role, focusRequest]);

  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.popover, () => onClose('escape'));
  }, [present, onClose]);

  useEffect(() => {
    if (!present) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A submenu is part of the popover although its DOM is elsewhere.
      if (surface.current?.contains(target) || anchor?.contains(target) || isInsideOwned(target, id)) return;
      onClose('outside');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [present, onClose, anchor, id]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !isOwnEvent(event.currentTarget, event)) return;
    if (role === 'menu') {
      // Focus goes back to the trigger, then the browser's own Tab moves on from there.
      onClose('tab');
      return;
    }
    cycleTab(event, event.currentTarget);
  };

  return (
    <div
      ref={positioner}
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...motionProps}
        ref={surface}
        id={id}
        role={role}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ transformOrigin: originOf(side, align) }}
        className={`glass-2 min-h-0 overflow-auto rounded-panel p-1 text-md text-text outline-none ${POPOVER_WIDTHS}`}
      >
        <PopoverScope.Provider value={id}>{children}</PopoverScope.Provider>
      </motion.div>
    </div>
  );
}
