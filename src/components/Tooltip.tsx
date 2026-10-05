import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { DISMISS_PRIORITY, registerDismissLayer } from './dismiss';
import { tokenMs } from './glide';
import { isFocusVisible } from './hooks';
import { EASE_OUT } from '../lib/motion';
import { DURATION } from './motion';
import type { Side } from './position';
import { useFloatingPosition } from './useFloatingPosition';

/** MOTION spell 16: `--tooltip-delay` before the first tooltip, `--tooltip-leave` after the pointer left (WCAG 1.4.13 hoverable). */
const delayMs = () => tokenMs('--tooltip-delay', 400);
const leaveMs = () => tokenMs('--tooltip-leave', 100);
/** A tooltip of the same group closed this recently: the next one opens at once, so sweeping along a toolbar does not stutter. */
const WARM_WINDOW = 300;
/** `--motion-fast-exit` in seconds (src/lib/motion.ts has no exit durations). */
const FAST_EXIT = 0.08;
/** `--ease-out`. */
const EASE: [number, number, number, number] = [...EASE_OUT];
/** One group is one toolbar, tab list or region: moving to a neighbour in it shows the next tooltip at once, without a fade. */
const GROUP = '[role="toolbar"], [role="tablist"], [data-tooltip-group], [data-region]';

/** Shared by all tooltips: at most one is open, and when and in which group the last one closed. */
const group: {
  openId: string | null;
  openGroup: Element | null;
  close: ((instant: boolean) => void) | null;
  closedAt: number;
  closedGroup: Element | null;
} = {
  openId: null,
  openGroup: null,
  close: null,
  closedAt: Number.NEGATIVE_INFINITY,
  closedGroup: null,
};

/** The group of an anchor wrapper: that of the anchor element inside it. */
const groupOf = (wrapper: HTMLElement | null): Element | null =>
  (wrapper?.firstElementChild ?? wrapper?.parentElement)?.closest(GROUP) ?? null;

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
 * Solid tooltip (DESIGN 3.4, MOTION spell 16). Opens after 400 ms of hover or keyboard focus; within a group (the same
 * toolbar, tab list or region) a neighbour's tooltip is there at once and the previous one goes without a fade. Stays
 * while the pointer is on the anchor or the tooltip, leaves 100 ms after the pointer has left, hides on blur, click,
 * pointer down, window blur and Esc. Esc closes only a shown tooltip and is not seen by anything below it.
 *
 * The anchor sits in a `display: contents` wrapper that listens for the pointer and focus events of everything inside
 * it, so any element works as anchor without forwarding props, and its own handlers are left alone.
 */
export function Tooltip({ label, shortcut, note, side = 'bottom', disabled = false, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  /** Shown without a fade (a neighbour in the group), and going without a fade (the neighbour took over). */
  const [instant, setInstant] = useState({ enter: false, exit: false });
  const wrapper = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const reduce = useReducedMotion() === true;

  const hideNow = useCallback(
    (now = false) => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      if (group.openId === id) {
        group.openId = null;
        group.close = null;
        group.closedAt = Date.now();
        group.closedGroup = group.openGroup;
        group.openGroup = null;
      }
      setInstant((state) => ({ ...state, exit: now }));
      setOpen(false);
    },
    [id],
  );

  const showNow = useCallback(
    (warm: boolean) => {
      if (group.openId !== null && group.openId !== id) group.close?.(warm);
      group.openId = id;
      group.openGroup = groupOf(wrapper.current);
      group.close = hideNow;
      setInstant({ enter: warm, exit: false });
      setOpen(true);
    },
    [id, hideNow],
  );

  const requestShow = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (group.openId === id) return;
    window.clearTimeout(showTimer.current);
    const mine = groupOf(wrapper.current);
    const warm =
      mine !== null &&
      ((group.openId !== null && group.openGroup === mine) ||
        (group.closedGroup === mine && Date.now() - group.closedAt < WARM_WINDOW));
    if (warm) showNow(true);
    else showTimer.current = window.setTimeout(() => showNow(false), delayMs());
  }, [id, showNow]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => hideNow(), leaveMs());
  }, [hideNow]);

  const keepOpen = useCallback(() => window.clearTimeout(hideTimer.current), []);

  // Esc closes this tooltip before anything beneath it.
  useEffect(() => {
    if (!open) return;
    return registerDismissLayer(DISMISS_PRIORITY.tooltip, () => hideNow());
  }, [open, hideNow]);

  // A tooltip must not linger when the pointer left without a leave event on the anchor (the anchor moved or was replaced
  // under the pointer, the pointer left the window, the window lost focus): while open, the pointer is watched.
  useEffect(() => {
    if (!open) return;
    let pending = false;
    const onMove = (event: PointerEvent) => {
      const at = event.target instanceof Element ? event.target : null;
      const inside =
        at !== null && (wrapper.current?.contains(at) === true || at.closest(`[data-tooltip-id="${id}"]`) !== null);
      if (inside) {
        pending = false;
        window.clearTimeout(hideTimer.current);
      } else if (!pending) {
        pending = true;
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => hideNow(), leaveMs());
      }
    };
    const onAway = () => hideNow();
    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onAway);
    window.addEventListener('blur', onAway);
    document.addEventListener('visibilitychange', onAway);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('mouseleave', onAway);
      window.removeEventListener('blur', onAway);
      document.removeEventListener('visibilitychange', onAway);
    };
  }, [open, id, hideNow]);

  // A tooltip that goes away with its anchor must not leave a timer or the group slot behind.
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      if (group.openId === id) {
        group.openId = null;
        group.openGroup = null;
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
          if (!disabled && event.pointerType !== 'touch') requestShow();
        }}
        onPointerLeave={scheduleHide}
        onPointerDown={() => hideNow()}
        onClick={() => hideNow()}
        onFocus={(event) => {
          // Only keyboard focus: a mouse click focuses the control too, and the hover tooltip already covers that.
          if (!disabled && isFocusVisible(event.target as Element)) requestShow();
        }}
        onBlur={() => hideNow()}
      >
        {children}
      </span>
      {createPortal(
        <AnimatePresence custom={instant.exit}>
          {visible && (
            <Bubble
              key="tooltip"
              id={id}
              wrapper={wrapper}
              side={side}
              label={label}
              shortcut={shortcut}
              note={note}
              onPointerEnter={keepOpen}
              onPointerLeave={scheduleHide}
              instantEnter={instant.enter}
              instantExit={instant.exit}
              reduce={reduce}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

interface BubbleProps {
  id: string;
  wrapper: RefObject<HTMLElement | null>;
  side: Side;
  label: string;
  shortcut: string | undefined;
  note: string | undefined;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  instantEnter: boolean;
  instantExit: boolean;
  /** Reduced motion: the same fade, nothing else (a tooltip only ever fades). */
  reduce: boolean;
}

// 240 px (DESIGN 3.4 max width): `--tooltip-max`.
const MAX_WIDTH = 'max-w-tooltip-max';

const variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: DURATION.fast, ease: EASE } },
  gone: (instant: boolean) => ({
    opacity: 0,
    transition: { duration: instant ? 0 : FAST_EXIT, ease: EASE },
  }),
};

function Bubble({
  id,
  wrapper,
  side,
  label,
  shortcut,
  note,
  onPointerEnter,
  onPointerLeave,
  instantEnter,
  instantExit,
  reduce,
}: BubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useFloatingPosition({ anchor: wrapper, floatingRef: ref, active: present, side, align: 'center' });
  // A neighbour's tooltip is simply there (no fade in); reduced motion keeps the fade.
  const skipEnter = instantEnter && !reduce;

  return (
    <div
      ref={ref}
      role="tooltip"
      aria-hidden="true"
      data-tooltip-id={id}
      className={`fixed start-0 top-0 z-tooltip ${present ? '' : 'pointer-events-none'}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <motion.div
        variants={variants}
        initial={skipEnter ? false : 'hidden'}
        animate="shown"
        exit="gone"
        custom={instantExit}
        className={`flex ${MAX_WIDTH} flex-col justify-center rounded-sm border border-border-subtle bg-tooltip-bg px-2 py-1 text-sm text-tooltip-text shadow-floating outline outline-transparent`}
      >
        <span className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut !== undefined && (
            <kbd className="inline-flex h-(--space-5) min-w-(--space-5) items-center justify-center rounded-sm border border-border bg-subtle px-1 font-sans text-xs font-medium text-tooltip-text tabular-nums">
              {shortcut}
            </kbd>
          )}
        </span>
        {note !== undefined && <span className="text-text-muted">{note}</span>}
      </motion.div>
    </div>
  );
}
