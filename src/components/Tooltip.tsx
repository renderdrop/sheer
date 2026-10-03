import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { DISMISS_PRIORITY, registerDismissLayer } from './dismiss';
import { isFocusVisible } from './hooks';
import { DURATION, useFade } from './motion';
import type { Side } from './position';
import { useFloatingPosition } from './useFloatingPosition';

/** Delays of DESIGN 1.6 and 3.4, in ms. */
const HOVER_DELAY = 500;
const KEYBOARD_DELAY = 300;
/** Another tooltip closed this recently: the next one opens at once, so sweeping along a toolbar does not stutter. */
const WARM_WINDOW = 300;
/** Time the pointer may spend between anchor and tooltip before the tooltip hides (WCAG 1.4.13 hoverable). */
const GRACE = 100;

/** Shared by all tooltips: at most one is open, and the time the last one closed. */
const group: { openId: string | null; close: (() => void) | null; closedAt: number } = {
  openId: null,
  close: null,
  closedAt: Number.NEGATIVE_INFINITY,
};

export interface TooltipProps {
  /** The control's name. Controls duplicate it as `aria-label`; the tooltip itself is `aria-hidden`. */
  label: string;
  /** Platform key chip, already formatted for display ("Ctrl+O", "⌘O"). */
  shortcut?: string;
  /** Second line, for example "Locked · Esc to release". */
  note?: string;
  /** Default `bottom`: below toolbar anchors. Use `right` for panel anchors. */
  side?: Side;
  disabled?: boolean;
  /** The anchor: one element. */
  children: ReactNode;
}

/**
 * Solid tooltip (DESIGN 3.4). Opens after 500 ms of hover or 300 ms of keyboard focus (at once when another tooltip
 * closed less than 300 ms ago), stays while the pointer is on the anchor or the tooltip (100 ms grace), hides on
 * blur, click and Esc. Esc closes only a shown tooltip and is not seen by anything below it.
 *
 * The anchor sits in a `display: contents` wrapper that listens for the pointer and focus events of everything inside
 * it, so any element works as anchor without forwarding props, and its own handlers are left alone.
 */
export function Tooltip({ label, shortcut, note, side = 'bottom', disabled = false, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const motionProps = useFade(DURATION.base, DURATION.fast);

  const hideNow = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    if (group.openId === id) {
      group.openId = null;
      group.close = null;
      group.closedAt = Date.now();
    }
    setOpen(false);
  }, [id]);

  const showNow = useCallback(() => {
    if (group.openId !== null && group.openId !== id) group.close?.();
    group.openId = id;
    group.close = hideNow;
    setOpen(true);
  }, [id, hideNow]);

  const requestShow = useCallback(
    (keyboard: boolean) => {
      window.clearTimeout(hideTimer.current);
      if (group.openId === id) return;
      window.clearTimeout(showTimer.current);
      const warm = group.openId !== null || Date.now() - group.closedAt < WARM_WINDOW;
      const delay = warm ? 0 : keyboard ? KEYBOARD_DELAY : HOVER_DELAY;
      if (delay === 0) showNow();
      else showTimer.current = window.setTimeout(showNow, delay);
    },
    [id, showNow],
  );

  const scheduleHide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(hideNow, GRACE);
  }, [hideNow]);

  const keepOpen = useCallback(() => window.clearTimeout(hideTimer.current), []);

  // Esc closes this tooltip before anything beneath it.
  useEffect(() => {
    if (!open) return;
    return registerDismissLayer(DISMISS_PRIORITY.tooltip, hideNow);
  }, [open, hideNow]);

  // A tooltip that goes away with its anchor must not leave a timer or the group slot behind.
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      if (group.openId === id) {
        group.openId = null;
        group.close = null;
      }
    },
    [id],
  );

  const visible = open && !disabled && label !== '';

  return (
    <>
      <span
        ref={wrapper}
        style={{ display: 'contents' }}
        onPointerEnter={(event) => {
          // Touch has no hover; a long press must not leave a tooltip behind.
          if (!disabled && event.pointerType !== 'touch') requestShow(false);
        }}
        onPointerLeave={scheduleHide}
        onPointerDown={hideNow}
        onClick={hideNow}
        onFocus={(event) => {
          // Only keyboard focus: a mouse click focuses the control too, and the hover tooltip already covers that.
          if (!disabled && isFocusVisible(event.target as Element)) requestShow(true);
        }}
        onBlur={hideNow}
      >
        {children}
      </span>
      {createPortal(
        <AnimatePresence>
          {visible && (
            <Bubble
              key="tooltip"
              wrapper={wrapper}
              side={side}
              label={label}
              shortcut={shortcut}
              note={note}
              onPointerEnter={keepOpen}
              onPointerLeave={scheduleHide}
              motionProps={motionProps}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

interface BubbleProps {
  wrapper: RefObject<HTMLElement | null>;
  side: Side;
  label: string;
  shortcut: string | undefined;
  note: string | undefined;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  motionProps: ReturnType<typeof useFade>;
}

// 240 px (DESIGN 3.4 max width): `--tooltip-max`.
const MAX_WIDTH = 'max-w-tooltip-max';

function Bubble({ wrapper, side, label, shortcut, note, onPointerEnter, onPointerLeave, motionProps }: BubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useFloatingPosition({ anchor: wrapper, floatingRef: ref, active: present, side, align: 'center' });

  return (
    <div
      ref={ref}
      role="tooltip"
      aria-hidden="true"
      className={`fixed start-0 top-0 z-tooltip ${present ? '' : 'pointer-events-none'}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <motion.div
        {...motionProps}
        className={`flex min-h-control-sm ${MAX_WIDTH} flex-col justify-center rounded-sm bg-tooltip-bg px-1 py-0-5 text-sm text-tooltip-text outline outline-transparent`}
      >
        <span className="flex items-center gap-1">
          <span>{label}</span>
          {shortcut !== undefined && (
            <kbd className="rounded-xs bg-tooltip-text/12 px-0-5 font-sans text-xs text-tooltip-key">{shortcut}</kbd>
          )}
        </span>
        {note !== undefined && <span className="text-tooltip-key">{note}</span>}
      </motion.div>
    </div>
  );
}
