import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cx } from './cx';
import { EASE_OUT, prefersReducedMotion, tokenMs } from './glide';

/** Icon sizes of DESIGN v2 section 4 in px: 16 default, 18 nav, 20 toolbar tools, 24 only for the Home "+" and empty-state actions. */
export type IconSize = 16 | 18 | 20 | 24;

// Static class names so Tailwind finds them. Sizes and stroke widths are tokens (`--icon-*`).
const SIZE: Record<IconSize, string> = {
  16: 'size-icon-16',
  18: 'size-icon-18',
  20: 'size-icon-20',
  24: 'size-icon-24',
};
// 1.75 px strokes at every size. CSS wins over the `stroke-width` attribute Lucide writes.
const STROKE = '[stroke-width:var(--icon-stroke)]';

/** Hosts whose pointer entry makes an icon react (F22.6). Icons outside such a host stay still. */
const HOST =
  'button, a[href], label, summary, [role="button"], [role="menuitem"], [role="menuitemradio"], ' +
  '[role="menuitemcheckbox"], [role="tab"], [role="option"], [role="link"]';
const GEOMETRY = 'path, line, circle, rect, polyline, polygon, ellipse';
// A colour utility passed by the caller (`text-text`); `text-sm` and friends only set a size.
const OWN_COLOUR = /(^|\s)text-(?!(xs|sm|md|lg|base|xl)(\s|$))/;

function cancelDraws(svg: SVGSVGElement): void {
  for (const shape of svg.querySelectorAll<SVGGeometryElement>(GEOMETRY)) {
    for (const running of shape.getAnimations?.() ?? []) running.cancel();
  }
}

/** Draws every shape once: dash = length, offset length to 0. Lucide's `nonScalingStroke` dashes in screen px. */
function draw(svg: SVGSVGElement): void {
  const duration = tokenMs('--motion-draw', 200);
  const scale = svg.getBoundingClientRect().width / 24 || 1;
  // A running draw is cancelled first, so a re-entry restarts and nothing is left behind (no fill-forwards).
  cancelDraws(svg);
  for (const shape of svg.querySelectorAll<SVGGeometryElement>(GEOMETRY)) {
    const length = shape.getTotalLength?.() ?? 0;
    if (!Number.isFinite(length) || length <= 0 || typeof shape.animate !== 'function') continue;
    const dash = `${length * scale}px`;
    shape.animate(
      [
        { strokeDasharray: dash, strokeDashoffset: dash },
        { strokeDasharray: dash, strokeDashoffset: '0px' },
      ],
      { duration, easing: EASE_OUT },
    );
  }
}

export interface IconProps {
  icon: LucideIcon;
  /** Default 16. */
  size?: IconSize;
  className?: string;
}

/**
 * A decorative Lucide icon: `currentColor`, hidden from assistive technology (the control around it carries the
 * name). `nonScalingStroke` is Lucide's replacement for `absoluteStrokeWidth`: the stroke stays 1.75 px at every size.
 * Inside an interactive host it draws itself once on the host's pointer entry (F22.6) and takes the rest/hover colours of
 * the `.sheer-icon` rules in tokens.css; a colour class in `className` keeps its own colour.
 */
export function Icon({ icon: Glyph, size = 16, className }: IconProps) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    const host = svg?.closest(HOST) ?? null;
    if (svg === null || host === null) return;
    const onEnter = () => {
      if (host.matches(':disabled, [aria-disabled="true"]') || prefersReducedMotion()) return;
      draw(svg);
    };
    host.addEventListener('pointerenter', onEnter);
    return () => {
      host.removeEventListener('pointerenter', onEnter);
      cancelDraws(svg);
    };
  }, []);
  const ownColour = className !== undefined && OWN_COLOUR.test(className);
  return (
    <Glyph
      ref={ref}
      aria-hidden="true"
      focusable="false"
      nonScalingStroke
      data-icon-colour={ownColour ? '' : undefined}
      className={cx('sheer-icon shrink-0', SIZE[size], STROKE, className)}
    />
  );
}
