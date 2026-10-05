import { useEffect, useId, type CSSProperties } from 'react';

import { watchAmbient } from './ambient';
import { useSurfaceMode } from './Surface';

export type SolarGlowVariant = 'hero' | 'empty' | 'card' | 'drop' | 'splash';

export interface SolarGlowProps {
  variant: SolarGlowVariant;
  className?: string;
}

const BACKGROUND: Record<SolarGlowVariant, string> = {
  hero: 'var(--glow-hero)',
  empty: 'var(--glow-empty)',
  card: 'var(--glow-card)',
  drop: 'var(--glow-drop)',
  splash: 'var(--glow-splash)',
};

/** A stable 0..1 fraction from an id, so each glow starts at its own point of the drift loop. */
export function phaseOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash / 997;
}

/**
 * One decorative light layer (DESIGN v2 section 5) that drifts 3 % in a 60 s loop on its own layer (MOTION spell 11). It starts 10 % outside its parent, which must be positioned and clip
 * (`relative overflow-hidden` with its radius). Inside a `WorkSurface` it throws in dev and renders nothing in production.
 */
export function SolarGlow({ variant, className }: SolarGlowProps) {
  const mode = useSurfaceMode();
  const id = useId();
  useEffect(() => watchAmbient(), []);
  if (mode === 'work') {
    if (import.meta.env.DEV) throw new Error('SolarGlow is not allowed inside a WorkSurface');
    return null;
  }
  const style: CSSProperties = {
    position: 'absolute',
    inset: '-10%',
    pointerEvents: 'none',
    willChange: 'transform',
    background: BACKGROUND[variant],
    // Drift (MOTION spell 11, tokens.css R5-D): a phase offset per glow into the --drift loop.
    ['--glow-phase' as string]: phaseOf(id).toFixed(3),
  };
  return <div aria-hidden="true" data-glow={variant} className={className} style={style} />;
}
