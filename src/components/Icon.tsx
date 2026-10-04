import type { LucideIcon } from 'lucide-react';

import { cx } from './cx';

/** Icon sizes of DESIGN 1.8 in px: 12 badges and status, 16 default, 20 toolbar tools, 24 empty-state tile, 8 lock glyph. */
export type IconSize = 8 | 12 | 16 | 20 | 24;

// Static class names so Tailwind finds them. Sizes and stroke widths are tokens (`--icon-*`).
const SIZE: Record<IconSize, string> = {
  8: 'size-2',
  12: 'size-icon-12',
  16: 'size-icon-16',
  20: 'size-icon-20',
  24: 'size-icon-24',
};
// 1.5 px strokes, 2 px at 12 and below (DESIGN 1.8). CSS wins over the `stroke-width` attribute Lucide writes.
const STROKE_DEFAULT = '[stroke-width:var(--icon-stroke)]';
const STROKE_SMALL = '[stroke-width:var(--icon-stroke-sm)]';

export interface IconProps {
  icon: LucideIcon;
  /** Default 16. */
  size?: IconSize;
  className?: string;
}

/**
 * A decorative Lucide icon: `currentColor`, hidden from assistive technology (the control around it carries the
 * name). `nonScalingStroke` is Lucide's replacement for `absoluteStrokeWidth`: the stroke stays 1.5 px at every size.
 */
export function Icon({ icon: Glyph, size = 16, className }: IconProps) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      nonScalingStroke
      className={cx('shrink-0', SIZE[size], size <= 12 ? STROKE_SMALL : STROKE_DEFAULT, className)}
    />
  );
}
