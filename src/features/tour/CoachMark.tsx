import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { Check, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Button, Icon, IconButton, pulse } from '../../components';
import { DURATION, usePopoverMotion } from '../../components/motion';
import { useNoticeSlot } from '../../components/notices';
import { tokenPx } from '../../components/tokens';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { useT } from '../../i18n';
import { readSlots, usePages } from '../../stores/pages';
import { TOOL_ROW, resolveAnchor, type AnchorSpec, type ResolvedAnchor } from './anchors';
import { usePlace } from './place';
import { SHIPPED_STEPS, pageIdOfKind, type TourStep } from './steps';
import { useTour } from './store';
import { stepText } from './text';
import { useStepParams } from './useStepParams';

/** The id of the card, for the pill's `aria-controls`. */
export const COACH_MARK_ID = 'tour-coach-mark';

/** Whether a popover, menu or dialog is open (they are portaled to the body): the card yields to them (DESIGN 3.14). */
function overlayOpen(): boolean {
  return document.querySelector('[role="menu"], [role="dialog"], [aria-modal="true"]') !== null;
}

function useOverlayOpen(active: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    const update = () => setOpen(overlayOpen());
    update();
    // Popovers, menus and dialogs are direct children of the body, so watching its children is enough.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [active]);
  return active && open;
}

/** The canvas's scroller: the slot the card stays inside, 16 px from its edges and clear of its scrollbar. */
const CANVAS_SCROLLER = '[data-action-scope="canvas"] > [role="region"]';

/** The scroll extent the card asks of the canvas: `Canvas` adds it as a margin after its content, which never changes the viewport it reports. */
export const CANVAS_EXTRA_SCROLL = '--canvas-extra-scroll';

/** The canvas's scroller, looked up again when the canvas remounts (another document came forward) while the card is active. */
function useCanvasScroller(active: boolean): HTMLElement | null {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const find = () => {
      const next = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
      setScroller((previous) => (previous === next ? previous : next));
    };
    find();
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          find();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active]);
  return active ? scroller : null;
}

/**
 * While the card sits over the canvas (it was placed above its anchor, at the status bar), the canvas gets extra scroll height
 * after its last page equal to the card's height, so what the step refers to can be scrolled clear of it. It is a custom property
 * that `Canvas` turns into a margin, so the viewport the canvas reports does not change. Only a canvas that scrolls already gets it
 * (no scrollbar may appear). Removed when the card goes (the step ends, is skipped, or unmounts).
 */
function useCanvasClearance(
  positioner: RefObject<HTMLElement | null>,
  card: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const scroller = useCanvasScroller(active);
  useLayoutEffect(() => {
    const box = card.current;
    if (!active || scroller === null || box === null) return;
    const apply = () => {
      const over = positioner.current?.dataset.side === 'top' && scroller.scrollHeight > scroller.clientHeight;
      if (over) scroller.style.setProperty(CANVAS_EXTRA_SCROLL, `calc(var(--spacing-6) + ${box.offsetHeight}px)`);
      else scroller.style.removeProperty(CANVAS_EXTRA_SCROLL);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(box);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty(CANVAS_EXTRA_SCROLL);
    };
  }, [positioner, card, active, scroller]);
}

/** The anchor element of the running step; looked up again after a resize, since the toolbar may move the control into More. */
function useAnchor(name: string | undefined): ResolvedAnchor | null {
  const [anchor, setAnchor] = useState<ResolvedAnchor | null>(null);
  useLayoutEffect(() => {
    if (name === undefined) return;
    const find = () =>
      setAnchor((previous) => {
        const next = resolveAnchor(name);
        return previous?.element === next?.element ? previous : next;
      });
    find();
    window.addEventListener('resize', find);
    // The toolbar collapses and restores items after its own resize pass, and a panel mounts its thumbnails after it opens: look
    // again once the DOM has settled (at most once per frame).
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          find();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('resize', find);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [name]);
  return name === undefined ? null : anchor;
}

/**
 * The anchor ring (MOTION 4.7 layer held at `--pulse-opacity`): a fixed, click-through box over the anchor, so no control has to
 * know about the tour. It follows the anchor and carries the success pulse.
 */
function Ring({ anchor, ringRef }: { anchor: HTMLElement; ringRef: RefObject<HTMLDivElement | null> }) {
  useLayoutEffect(() => {
    const ring = ringRef.current;
    if (ring === null) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const rect = anchor.getBoundingClientRect();
      ring.style.left = `${rect.left}px`;
      ring.style.top = `${rect.top}px`;
      ring.style.width = `${rect.width}px`;
      ring.style.height = `${rect.height}px`;
      ring.style.setProperty('--pulse-radius', getComputedStyle(anchor).borderTopLeftRadius);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [anchor, ringRef]);
  return (
    <div
      ref={ringRef}
      aria-hidden="true"
      data-tour-ring=""
      className="pulse-target pointer-events-none fixed z-popover"
    />
  );
}

/** Where the card sits next to a canvas target: below it, flipping when there is no room. */
const TARGET_SPEC: AnchorSpec = { selector: '', side: 'bottom', align: 'center' };

/**
 * Phase b on the canvas: an invisible fixed box over the step's target rect on its page, following scroll, zoom and panel slides
 * every frame (DESIGN 3.14). `null` while the page is not on screen (the card then stays at the tool).
 */
function useCanvasTarget(docId: number | null, step: TourStep | undefined, active: boolean): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const stepId = step?.id;
  useLayoutEffect(() => {
    const target = step?.target;
    const pageId = step === undefined ? null : pageIdOfKind(SHIPPED_STEPS, step.page);
    if (!active || docId === null || target === undefined || pageId === null) return;
    const node = document.createElement('div');
    node.setAttribute('aria-hidden', 'true');
    node.dataset.tourTarget = '';
    Object.assign(node.style, { position: 'fixed', pointerEvents: 'none', visibility: 'hidden' });
    document.body.append(node);
    let frame = 0;
    let shown = false;
    const place = () => {
      const index = readSlots(docId).findIndex((slot) => slot.id === pageId);
      const page = index < 0 ? null : document.querySelector<HTMLElement>(`[data-page="${index + 1}"]`);
      const widthPt = usePages.getState().byDoc[docId]?.[index]?.[0];
      if (page === null || widthPt === undefined || widthPt <= 0) {
        if (shown) setElement(null);
        shown = false;
      } else {
        const box = page.getBoundingClientRect();
        const scale = box.width / widthPt;
        node.style.left = `${box.left + target.x * scale}px`;
        node.style.top = `${box.top + target.y * scale}px`;
        node.style.width = `${target.w * scale}px`;
        node.style.height = `${target.h * scale}px`;
        if (!shown) setElement(node);
        shown = true;
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
      node.remove();
      setElement(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the step is read through its id; its geometry never changes
  }, [active, docId, stepId]);
  return active ? element : null;
}

interface CardProps {
  anchor: ResolvedAnchor;
}

/** The card itself. It is mounted while it is shown, so its entrance and exit are the popover's (opacity + scale, DESIGN 3.14). */
function Card({ anchor }: CardProps) {
  const t = useT();
  const positioner = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  const titleId = useId();
  const textId = useId();
  const index = useTour((state) => state.index);
  const phase = useTour((state) => state.phase);
  const focusCard = useTour((state) => state.focusCard);
  const hide = useTour((state) => state.hide);
  const skip = useTour((state) => state.skip);
  const next = useTour((state) => state.next);
  const back = useTour((state) => state.back);
  const clearFocusRequest = useTour((state) => state.clearFocusRequest);
  const step = SHIPPED_STEPS[index];
  const total = SHIPPED_STEPS.length;
  const done = phase === 'done';
  const last = index + 1 >= total;
  /** Completed steps over the total: a skipped step fills the bar all the same (DESIGN 3.6). */
  const filled = index + (done ? 1 : 0);
  const params = useStepParams();
  const { title, text } = stepText(t, step, params);
  const reduce = useReducedMotion() === true;
  const anchorEl = anchor.element;

  useFloatingPosition({
    anchor: anchorEl,
    floatingRef: positioner,
    active: present,
    side: anchor.spec.side,
    align: anchor.spec.align,
    kind: 'coach',
    clampTo: { selector: CANVAS_SCROLLER, inset: tokenPx('--space-4', 16) },
    clearOf: TOOL_ROW,
  });
  useCanvasClearance(positioner, card, present);

  // The pill's Enter shows the card and focuses Next; it never takes focus on appearing otherwise.
  useLayoutEffect(() => {
    if (!focusCard) return;
    card.current?.querySelector<HTMLElement>('[data-tour-next]')?.focus({ preventScroll: true });
    clearFocusRequest();
  }, [focusCard, clearFocusRequest]);

  // While the step is on, the anchor is described by the instruction, so a screen reader reading it hears what to do.
  useEffect(() => {
    anchorEl.setAttribute('aria-describedby', textId);
    return () => {
      if (anchorEl.getAttribute('aria-describedby') === textId) anchorEl.removeAttribute('aria-describedby');
    };
  }, [anchorEl, textId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Esc with focus inside hides the card and restores the focus the region had before; elsewhere Esc is not ours.
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    hide();
    const back = lastFocus.current;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  return (
    <div
      ref={positioner}
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.section
        {...motionProps}
        ref={card}
        id={COACH_MARK_ID}
        role="region"
        aria-labelledby={titleId}
        data-tour-card=""
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const from = event.relatedTarget;
          if (from instanceof HTMLElement && !card.current?.contains(from)) lastFocus.current = from;
        }}
        className="bg-panel border border-control-border shadow-floating flex w-popover-max max-w-full flex-col rounded-panel p-4 text-md text-text"
      >
        <div aria-hidden="true" className="bg-track h-progress w-full overflow-hidden rounded-pill">
          <motion.div
            data-tour-progress=""
            className="bg-accent h-full w-full origin-left rounded-pill"
            initial={false}
            animate={{ scaleX: filled / total }}
            transition={{ duration: reduce ? 0 : DURATION.base, ease: [0.2, 0, 0, 1] }}
          />
        </div>
        <div className="mt-3 flex h-6 items-center gap-2">
          <span
            data-tour-count=""
            aria-label={t('tour.stepOf', { step: index + 1, total })}
            className="t-caption text-text-muted tabular-nums"
          >
            {t('tour.count', { step: index + 1, total })}
          </span>
          <span className="flex-auto" />
          <IconButton label={t('tour.hide')} icon={X} size="sm" onClick={hide} />
        </div>
        <h2 id={titleId} className="t-title m-0 mt-2 flex items-center gap-1 text-text">
          {done ? <Icon icon={Check} size={16} /> : null}
          {done ? t('tour.done', { title }) : title}
        </h2>
        <p id={textId} className="t-body m-0 mt-1 text-text">
          {text}
        </p>
        <div className="mt-4 flex h-control-sm items-center">
          <Button variant="ghost" size="sm" onClick={skip} className="ms-[calc(-1*var(--spacing-3))]">
            {t('tour.skip')}
          </Button>
          <span className="flex-auto" />
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={index === 0} focusableWhenDisabled onClick={back}>
              {t('tour.back')}
            </Button>
            <Button variant="primary" size="sm" data-tour-next="" onClick={next}>
              {last ? t('tour.finish') : t('tour.next')}
            </Button>
          </div>
        </div>
      </motion.section>
    </div>
  );
}

/**
 * The coach mark (DESIGN 3.14): one non-modal hint at a time, next to the control (or, later, the canvas target) where the step
 * happens, with a ring on the anchor. It never takes focus, yields to popovers and dialogs, and is hidden by Esc inside it or the
 * x button (the pill brings it back). Mounted once, beside the shell; it renders into the body like the popovers.
 */
export function CoachMark() {
  const t = useT();
  const docId = useTour((state) => state.docId);
  const index = useTour((state) => state.index);
  const phase = useTour((state) => state.phase);
  const hidden = useTour((state) => state.hidden);
  const paused = useTour((state) => state.paused);
  const params = useStepParams();
  const ringRef = useRef<HTMLDivElement>(null);
  const step = docId === null ? undefined : SHIPPED_STEPS[index];
  const place = usePlace(step);
  const canvasTarget = useCanvasTarget(docId, step, place?.canvasTarget === true);
  // While the canvas target is not there (page off screen), the tool stays the anchor.
  const named = useAnchor(place === null ? undefined : place.canvasTarget ? step?.anchor.a : place.name);
  const anchor: ResolvedAnchor | null = canvasTarget === null ? named : { element: canvasTarget, spec: TARGET_SPEC };
  const yielding = useOverlayOpen(step !== undefined);
  const wanted = step !== undefined && anchor !== null && phase !== 'finishing' && !paused && !hidden && !yielding;
  // One notice at a time (DESIGN 3.9 Q8): an info toast or a tip never shows beside the card; an error toast takes the slot.
  const slot = useNoticeSlot('coach', 'coach', wanted);

  // The success moment: the ring pulses and the status bar announces it; the last one also points at the closing page.
  useEffect(() => {
    if (phase !== 'done' || step === undefined) return;
    const { title } = stepText(t, step, params);
    const closing = index + 1 >= SHIPPED_STEPS.length ? ` ${t('tour.toClosing')}` : '';
    if (ringRef.current !== null) pulse(ringRef.current, t('tour.done', { title }) + closing);
  }, [phase, step, index, t, params]);

  // Paused (another tab is in front): card and ring are hidden, the pill keeps the count.
  if (step === undefined || anchor === null || phase === 'finishing' || paused) return null;
  return createPortal(
    <>
      <Ring key={step.id} anchor={anchor.element} ringRef={ringRef} />
      <AnimatePresence>{slot && <Card key={step.id} anchor={anchor} />}</AnimatePresence>
    </>,
    document.body,
  );
}
