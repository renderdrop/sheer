import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { tokenMs } from '../../components/glide';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { useT } from '../../i18n';
import { EASE_OUT } from '../../lib/motion';
import { refusalKey } from './refusalKey';
import { useTextEdit, type Refusal } from './store';

/** MOTION spell 16, as `Tooltip`: the hover delay is `--tooltip-delay`. */
const delayMs = () => tokenMs('--tooltip-delay', 400);
/** `--motion-fast` in seconds (the fade; reduced motion keeps it, a tooltip only ever fades). */
const FADE = 0.12;
const EASE: [number, number, number, number] = [...EASE_OUT];

/**
 * The refusal tooltip of "Edit text" (DESIGN 3.10 E5): why the line under the pointer cannot be edited. The store's `refusal` carries
 * the line's rect in client pixels; the tooltip sits 8 above it (Q8). A hover waits for the normal tooltip delay, a click shows it
 * at once. It goes with the refusal (pointer left, tool released), on Esc, and never stays over a focused input (Q8 placement).
 */
export function RefusalTip() {
  const refusal = useTextEdit((state) => state.refusal);
  // Which refusal waited out the hover delay, and which one Esc closed (objects, so a new refusal starts afresh).
  const [ready, setReady] = useState<Refusal | null>(null);
  const [dismissed, setDismissed] = useState<Refusal | null>(null);
  const shown =
    refusal !== null && refusal !== dismissed && (refusal.via === 'click' || refusal === ready) ? refusal : null;

  useEffect(() => {
    if (refusal === null || refusal.via === 'click') return;
    const timer = window.setTimeout(() => setReady(refusal), delayMs());
    return () => window.clearTimeout(timer);
  }, [refusal]);

  useEffect(() => {
    if (shown === null) return;
    return registerDismissLayer(DISMISS_PRIORITY.tooltip, () => setDismissed(shown));
  }, [shown]);

  return createPortal(
    <AnimatePresence>{shown !== null && <Bubble key="refusal" refusal={shown} />}</AnimatePresence>,
    document.body,
  );
}

function Bubble({ refusal }: { refusal: Refusal }) {
  const t = useT();
  const reduce = useReducedMotion() === true;
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useFloatingPosition({
    anchor,
    floatingRef: ref,
    active: anchor !== null,
    side: 'top',
    align: 'center',
    kind: 'tooltip',
  });
  const { x, y, w, h } = refusal.rect;
  return (
    <>
      {/* The anchor: an invisible box over the refused line. */}
      <div
        ref={setAnchor}
        aria-hidden="true"
        className="pointer-events-none fixed"
        style={{ left: x, top: y, width: Math.max(0, w), height: Math.max(0, h) }}
      />
      <div
        ref={ref}
        role="tooltip"
        aria-hidden="true"
        data-surface="textedit-refusal"
        className="pointer-events-none fixed start-0 top-0 z-tooltip"
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: FADE, ease: EASE } }}
          exit={{ opacity: 0, transition: { duration: reduce ? FADE : 0.08, ease: EASE } }}
          className="flex max-w-tooltip-max flex-col justify-center rounded-sm border border-border-subtle bg-tooltip-bg px-2 py-1 text-sm text-tooltip-text shadow-floating outline outline-transparent"
        >
          {t(refusalKey(refusal.reason))}
        </motion.div>
      </div>
    </>
  );
}
