import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cx } from './cx';
import { prefersReducedMotion } from './glide';
import { playMotion } from './iconMotion';

/** Icon sizes of DESIGN v2 section 4 in px: 16 default, 18 nav, 20 toolbar tools, 24 only for the Home "+" and empty-state actions. */
export type IconSize = 16 | 18 | 20 | 24;

// Static class names so Tailwind finds them. Sizes and stroke widths are tokens (`--icon-*`).
const SIZE: Record<IconSize, string> = {
  16: 'size-icon-16',
  18: 'size-icon-18',
  20: 'size-icon-20',
  24: 'size-icon-24',
};
// The stroke in user units per size, so it is 1.75 px on screen at every size (`--icon-stroke-<size>`). CSS wins over the
// `stroke-width` attribute Lucide writes.
const STROKE: Record<IconSize, string> = {
  16: '[stroke-width:var(--icon-stroke-16)]',
  18: '[stroke-width:var(--icon-stroke-18)]',
  20: '[stroke-width:var(--icon-stroke-20)]',
  24: '[stroke-width:var(--icon-stroke-24)]',
};

/** Hosts whose pointer entry makes an icon react (F22.6). Icons outside such a host stay still. */
const HOST =
  'button, a[href], label, summary, [role="button"], [role="menuitem"], [role="menuitemradio"], ' +
  '[role="menuitemcheckbox"], [role="tab"], [role="option"], [role="link"]';
// A colour utility passed by the caller (`text-text`); `text-sm` and friends only set a size.
const OWN_COLOUR = /(^|\s)text-(?!(xs|sm|md|lg|base|xl)(\s|$))/;

export interface IconProps {
  icon: LucideIcon;
  /** Default 16. */
  size?: IconSize;
  className?: string;
}

/**
 * A decorative Lucide icon: `currentColor`, hidden from assistive technology (the control around it carries the name).
 * Inside an interactive host it plays its own motion once per pointer entry (iconMotion.ts, ADR-146 addendum 2); an entry
 * while it still runs does not restart it. It takes the rest/hover colours of the `.sheer-icon` rules in tokens.css; a colour
 * class in `className` keeps its own colour. Disabled hosts: nothing; reduced motion: colour only.
 */
export function Icon({ icon: Glyph, size = 16, className }: IconProps) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    const host = svg?.closest(HOST) ?? null;
    if (svg === null || host === null) return;
    let running: Animation[] = [];
    let busyUntil = 0;
    const onEnter = () => {
      if (host.matches(':disabled, [aria-disabled="true"]') || prefersReducedMotion()) return;
      const now = performance.now();
      if (now < busyUntil) return;
      const played = playMotion(svg, size);
      running = played.animations;
      busyUntil = now + played.total;
    };
    host.addEventListener('pointerenter', onEnter);
    return () => {
      host.removeEventListener('pointerenter', onEnter);
      for (const animation of running) animation.cancel();
      running = [];
    };
  }, [size]);
  const ownColour = className !== undefined && OWN_COLOUR.test(className);
  return (
    <Glyph
      ref={ref}
      aria-hidden="true"
      focusable="false"
      data-icon-colour={ownColour ? '' : undefined}
      className={cx('sheer-icon shrink-0', SIZE[size], STROKE[size], className)}
    />
  );
}
