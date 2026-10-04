import type { CSSProperties } from 'react';

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

/**
 * One decorative light layer (DESIGN v2 section 5). It starts 10 % outside its parent, which must be positioned and clip
 * (`relative overflow-hidden` with its radius). Inside a `WorkSurface` it throws in dev and renders nothing in production.
 */
export function SolarGlow({ variant, className }: SolarGlowProps) {
  const mode = useSurfaceMode();
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
  };
  return <div aria-hidden="true" data-glow={variant} className={className} style={style} />;
}
