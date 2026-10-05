import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Compass, Pause } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Icon, pulse } from '../../components';
import { SPRING } from '../../components/motion';
import { tokenPx } from '../../components/tokens';
import { useT } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { COACH_MARK_ID } from './CoachMark';
import { SHIPPED_STEPS } from './steps';
import { useTour } from './store';

/**
 * The tour pill (DESIGN 3.6), in the right cluster of the top bar: "Tour 2 / 7". Click, Enter or Space toggles the coach mark.
 * While another tab is in front it shows "2 / 7" with a pause glyph; a click then brings the welcome tab back and resumes. After
 * the last step it pulses and says "Tour complete" for a moment. It exists only while a tour runs.
 */
export function TourPill() {
  const t = useT();
  const docId = useTour((state) => state.docId);
  const index = useTour((state) => state.index);
  const phase = useTour((state) => state.phase);
  const hidden = useTour((state) => state.hidden);
  const paused = useTour((state) => state.paused);
  const toggle = useTour((state) => state.toggle);
  const reduce = useReducedMotion() === true;
  const pill = useRef<HTMLButtonElement>(null);
  const finishing = phase === 'finishing';
  const total = SHIPPED_STEPS.length;
  const step = index + 1;

  useEffect(() => {
    if (finishing && pill.current !== null) pulse(pill.current, t('tour.complete'));
  }, [finishing, t]);

  const onClick = () => {
    if (paused && docId !== null) {
      useDocuments.getState().setActive(docId);
      useTour.getState().resume();
      return;
    }
    toggle();
  };

  const label = finishing ? t('tour.complete') : paused ? t('tour.pillPaused') : t('tour.pillLabel', { step, total });

  return (
    <AnimatePresence>
      {docId !== null && (
        <motion.span
          key="pill"
          className="flex shrink-0"
          initial={{ opacity: 0, y: reduce ? 0 : tokenPx('--offset-enter', 8) }}
          animate={{ opacity: 1, y: 0, transition: reduce ? SPRING.fast : SPRING.slow }}
          exit={{ opacity: 0, transition: SPRING.fast }}
        >
          <button
            ref={pill}
            type="button"
            data-tour-pill=""
            aria-expanded={paused || finishing ? undefined : !hidden}
            aria-controls={paused || finishing ? undefined : COACH_MARK_ID}
            aria-label={label}
            onClick={onClick}
            className={`pulse-target t-caption inline-flex h-control-sm shrink-0 cursor-pointer items-center gap-1 rounded-pill border bg-subtle px-[calc(var(--space-2)+var(--space-1)/2)] font-medium tabular-nums text-text transition-colors duration-fast active:scale-(--scale-press) hover:bg-pressed ${
              !hidden && !paused && !finishing ? 'border-control-border' : 'border-transparent'
            }`}
          >
            <Icon icon={finishing ? Check : paused ? Pause : Compass} size={16} />
            {finishing ? (
              t('tour.complete')
            ) : paused ? (
              t('tour.count', { step, total })
            ) : (
              <>
                <span className="max-save-label:hidden">{t('tour.pill', { step, total })}</span>
                <span className="hidden max-save-label:inline">{t('tour.count', { step, total })}</span>
              </>
            )}
          </button>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
