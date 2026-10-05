import { useEffect } from 'react';

import { announce } from '../../components';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { TipHost } from '../tips/TipHost';
import { CoachMark } from './CoachMark';
import { bindTour, maybeFirstLaunch } from './runtime';
import { SHIPPED_STEPS } from './steps';
import { useTour } from './store';
import { stepText } from './text';
import { useStepParams } from './useStepParams';

/**
 * The welcome tour's work with no UI of its own, plus the coach mark: connects the engine to the stores, opens the welcome
 * document on the first launch (once `welcomeTour` is known to be pending), and announces each step's start in the status bar's
 * polite live region. Mounted once, with the shell.
 */
export function TourEffects() {
  const t = useT();
  const docId = useTour((state) => state.docId);
  const index = useTour((state) => state.index);
  const params = useStepParams();

  useEffect(() => bindTour(), []);

  useEffect(() => {
    void maybeFirstLaunch();
    return useSettings.subscribe(() => void maybeFirstLaunch());
  }, []);

  useEffect(() => {
    const step = docId === null ? undefined : SHIPPED_STEPS[index];
    if (step === undefined) return;
    const { title, text } = stepText(t, step, params);
    announce(t('tour.announce', { step: index + 1, total: SHIPPED_STEPS.length, title, text }));
  }, [docId, index, t, params]);

  return (
    <>
      <CoachMark />
      <TipHost />
    </>
  );
}
