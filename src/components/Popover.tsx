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
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';

import { Modal } from '../features/jobs/Modal';
import { DISMISS_PRIORITY, registerDismissLayer } from './dismiss';
import { cycleTab, TAB_STOPS } from './focusTrap';
import { useControllableState } from './hooks';
import { usePopoverMotion } from './motion';
import { isInsideOwned, layerFor, ownedBy, PopoverScope } from './popoverScope';
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
  /** A fixed outer width in px (it overrides the 200 to 320 range), for a popover that must fit a region such as the left panel. */
  width?: number;
  children: ReactNode | ((api: PopoverApi) => ReactNode);
}

type FocusRequest = 'first' | 'last' | 'auto';

/** The banner slot at the top of the canvas column (DESIGN v2 3.2). */
const BANNER_SLOT = '[data-region="banner"]';

/** The one open popover (DESIGN 3.5: one open at a time). Opening another closes it without moving focus. */
const openPopovers = new Map<string, { parent: string | null; close: (reason: PopoverCloseReason) => void }>();

/** Whether `ancestor` is `id` itself or a popover that `id` is rendered inside of (a colour popover in a split menu). */
function isAncestor(ancestor: string, id: string): boolean {
  for (let at: string | null | undefined = id; at !== null && at !== undefined; at = openPopovers.get(at)?.parent) {
    if (at === ancestor) return true;
  }
  return false;
}

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
  width,
  children,
}: PopoverProps) {
  const id = useId();
  const parent = useContext(PopoverScope);
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
    // The popovers this one is rendered in stay open; every other one closes.
    openPopovers.set(id, { parent, close });
    for (const [other, entry] of [...openPopovers]) {
      if (other !== id && !isAncestor(other, id)) entry.close('other');
    }
    return () => {
      openPopovers.delete(id);
    };
  }, [open, id, close, parent]);

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
              width={width}
              focusRequest={focusRequest}
              parent={parent}
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
  width: number | undefined;
  focusRequest: FocusRequest;
  /** The popover this one is rendered in: a click in this one is a click in that one. */
  parent: string | null;
  onClose: (reason: PopoverCloseReason) => void;
  children: ReactNode;
}

// 200 to 320 px wide (DESIGN 3.5): `--popover-min` and `--popover-max`. A submenu has the same width.
export const POPOVER_WIDTHS = 'min-w-popover-min max-w-popover-max';

/**
 * A menu sizes to its widest item (label and shortcut), never to the 320 cap, so no label is truncated (Q9.2); only the window
 * limits it (viewport minus the inset on both sides). Items of a menu are one line each.
 */
export const MENU_WIDTHS = 'min-w-popover-min w-max max-w-[calc(100vw-var(--space-4))]';

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

/**
 * The global surface rule (DESIGN 3.9 Q7): a popover sizes to its content, and one that fits no placement inside the
 * viewport minus the inset (Q8) renders as a dialog with the same content and the trigger's label as title. Menus
 * are lists: they scroll inside and are never turned into a dialog.
 */
function Surface(props: SurfaceProps) {
  const [asDialog, setAsDialog] = useState(false);
  const titleId = useId();
  if (asDialog) {
    return (
      <Modal labelledBy={titleId} width="w-dialog-md" onClose={() => props.onClose('escape')}>
        <h2 id={titleId} className="t-h3 m-0 mb-4">
          {props.label}
        </h2>
        <PopoverScope.Provider value={props.id}>{props.children}</PopoverScope.Provider>
      </Modal>
    );
  }
  return <FloatingSurface {...props} onNoFit={props.role === 'dialog' ? () => setAsDialog(true) : undefined} />;
}

function FloatingSurface({
  id,
  label,
  role,
  anchor,
  side,
  align,
  width,
  focusRequest,
  parent,
  onClose,
  onNoFit,
  children,
}: SurfaceProps & { onNoFit: (() => void) | undefined }) {
  const positioner = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  const layer = useMemo(() => layerFor(anchor), [anchor]);
  useFloatingPosition({
    anchor,
    floatingRef: positioner,
    active: present,
    side,
    align,
    kind: role === 'menu' ? 'menu' : 'popover',
    // A popover from the tool row never covers a banner (nothing overlaps): it sits below the banner slot or becomes a dialog.
    clearOf: role === 'menu' ? undefined : BANNER_SLOT,
    onNoFit,
  });

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
    // A long menu scrolls inside (Q7): the first or last item that took focus is brought into view.
    if (role === 'menu') target?.scrollIntoView?.({ block: 'nearest' });
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
      {...ownedBy(parent)}
      data-modal-popover={layer['data-modal-popover']}
      className={`fixed start-0 top-0 ${layer.className} flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...motionProps}
        ref={surface}
        id={id}
        role={role}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          transformOrigin: originOf(side, align),
          ...(width === undefined ? {} : { width, minWidth: width, maxWidth: width }),
        }}
        className={`bg-panel border border-border-subtle shadow-floating min-h-0 rounded-button text-md text-text outline-none ${role === 'menu' ? `overflow-y-auto overflow-x-hidden p-4 ${MENU_WIDTHS}` : `p-4 ${POPOVER_WIDTHS}`}`}
      >
        <PopoverScope.Provider value={id}>{children}</PopoverScope.Provider>
      </motion.div>
    </div>
  );
}
