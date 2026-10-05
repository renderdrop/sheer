import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { useT } from '../../i18n';
import { SPRING } from '../../lib/motion';
import { useUi } from '../../stores/ui';
import { DropCard } from '../viewer/DropCard';
import { useTransition } from '../viewer/openTransition';
import { DropGlow } from './dropGlow';

/** After the drag left the window the card stays this long: a drop that is accepted lets it fall (MOTION 4.5); otherwise it fades out. */
export const DROP_HOLD_MS = 250;

/**
 * Whether the drop target is shown, and whether the drop has been accepted: shown while the drag is over the window and for
 * `DROP_HOLD_MS` after it, `falling` once a document that was dropped has opened.
 */
export function useDropTarget(dropActive: boolean): { shown: boolean; falling: boolean } {
  const [holding, setHolding] = useState(false);
  const accepted = useTransition((state) => state.dropAccepted);
  const [seen, setSeen] = useState(accepted);
  const [wasActive, setWasActive] = useState(dropActive);
  // A drag that has just left holds the card; one that arrives starts afresh. (Derived while rendering, not in an effect.)
  if (wasActive !== dropActive) {
    setWasActive(dropActive);
    setHolding(!dropActive);
    if (dropActive) setSeen(accepted);
  }
  const falling = accepted !== seen;
  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(() => setHolding(false), DROP_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);
  return { shown: dropActive || holding || falling, falling };
}

/**
 * The drop target of Home: the whole window is one (the backend reports the drag as `ui.dropHover`). While a file is over it, the
 * preview card of MOTION 4.5 shows over the main column and the content behind fades out, so nothing overlaps.
 */
export function useHomeDrop(): { shown: boolean; falling: boolean } {
  return useDropTarget(useUi((state) => state.dropHover));
}

/** The overlay itself; the caller mounts it inside an `AnimatePresence` while `useHomeDrop().shown`. */
export function DropOverlay({ falling }: { falling: boolean }) {
  const t = useT();
  return (
    <motion.div
      key="drop-target"
      data-drop-target=""
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: SPRING.base }}
      exit={{ opacity: 0, transition: SPRING.fast }}
      className="pointer-events-none absolute inset-0 z-drag flex flex-col items-center justify-center gap-6"
    >
      <DropGlow />
      <div className="relative">
        <DropCard falling={falling} />
      </div>
      <p className="t-h3 relative m-0">{t('canvas.dropToOpen')}</p>
    </motion.div>
  );
}
