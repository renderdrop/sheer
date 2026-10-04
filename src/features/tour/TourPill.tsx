import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Compass } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button, pulse } from '../../components';
import { SPRING } from '../../components/motion';
import { tokenPx } from '../../components/tokens';
import { useT } from '../../i18n';
import { COACH_MARK_ID } from './CoachMark';
import { SHIPPED_STEPS } from './steps';
import { useTour } from './store';

/**
 * The progress pill (DESIGN 3.14), in the status bar after the file name: "Tour 2 / 3". Click, Enter or Space toggles the coach
 * mark. After the last step it pulses and says "Tour complete" for a moment. It exists only while a tour runs.
 */
export function TourPill() {
  const t = useT();
  const docId = useTour((state) => state.docId);
  const index = useTour((state) => state.index);
  const phase = useTour((state) => state.phase);
  const hidden = useTour((state) => state.hidden);
  const toggle = useTour((state) => state.toggle);
  const reduce = useReducedMotion() === true;
  const pill = useRef<HTMLButtonElement>(null);
  const finishing = phase === 'finishing';
  const total = SHIPPED_STEPS.length;
  const step = index + 1;

  useEffect(() => {
    if (finishing && pill.current !== null) pulse(pill.current, t('tour.complete'));
  }, [finishing, t]);

  return (
    <AnimatePresence>
      {docId !== null && (
        <motion.span
          key="pill"
          className="flex shrink-0"
          initial={{ opacity: 0, y: reduce ? 0 : tokenPx('--offset-enter', 8) }}
          animate={{ opacity: 1, y: 0, transition: SPRING.base }}
          exit={{ opacity: 0, transition: SPRING.fast }}
        >
          <Button
            ref={pill}
            variant="ghost"
            size="sm"
            icon={finishing ? Check : Compass}
            aria-expanded={!hidden}
            aria-controls={COACH_MARK_ID}
            aria-label={finishing ? t('tour.complete') : t('tour.pillLabel', { step, total })}
            onClick={toggle}
            className="pulse-target rounded-pill px-2 text-xs tabular-nums"
          >
            {finishing ? t('tour.complete') : t('tour.pill', { step, total })}
          </Button>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
