import { useEffect, useState } from 'react';

import { SolarGlow } from '../../components';
import { BrandSurface } from '../../components/Surface';
import { Wordmark } from '../../components/Wordmark';
import { useSettings } from '../../stores/settings';

/** `--splash-max`, mirrored (Splash.test.tsx reads tokens.css and fails on drift; MOTION spell 10): the splash is never on screen longer than this, whatever the load does. */
export const SPLASH_MAX_MS = 1500;
/** `--motion-slow`, mirrored the same way: the cross-fade into Home. */
export const SPLASH_FADE_MS = 180;

export type SplashPhase = 'shown' | 'leaving' | 'gone';

/**
 * The splash's life (MOTION spell 10): shown from the first paint until the app is `ready`, but at most `maxMs`; then it fades
 * (`leaving`) and goes. Ready at the first render means no splash at all: it is never held longer than the real load.
 */
export function useSplash(ready: boolean, maxMs: number = SPLASH_MAX_MS, fadeMs: number = SPLASH_FADE_MS): SplashPhase {
  const [phase, setPhase] = useState<SplashPhase>(ready ? 'gone' : 'shown');
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setCapped(true), maxMs);
    return () => window.clearTimeout(timer);
  }, [maxMs]);
  const done = ready || capped;
  const start = phase === 'shown' && done;
  if (start) setPhase('leaving');
  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = window.setTimeout(() => setPhase('gone'), fadeMs);
    return () => window.clearTimeout(timer);
  }, [phase, fadeMs]);
  return phase;
}

/**
 * The app start (MOTION spell 10): the word mark centred on Canvas with the `splash` glow breathing behind it, over the shell until
 * the settings have loaded (the first thing the backend answers) or `--splash-max`, then a cross-fade into Home. The breathing loop is
 * CSS (tokens.css R5-D): opacity only, a static 0.75 under reduced motion.
 */
export function Splash() {
  const ready = useSettings((state) => state.loaded);
  const phase = useSplash(ready);
  if (phase === 'gone') return null;
  return (
    <BrandSurface
      data-splash=""
      data-leaving={phase === 'leaving' ? '' : undefined}
      aria-hidden="true"
      className="pointer-events-auto fixed inset-0 z-modal flex items-center justify-center overflow-hidden bg-(--color-canvas)"
    >
      <div data-splash-glow="" className="pointer-events-none absolute inset-0" style={{ willChange: 'opacity' }}>
        <SolarGlow variant="splash" />
      </div>
      <Wordmark className="relative h-(--splash-wordmark) text-text-muted" />
    </BrandSurface>
  );
}
