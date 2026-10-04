import type { LucideIcon } from 'lucide-react';

import { cx } from './cx';

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

export interface IconProps {
  icon: LucideIcon;
  /** Default 16. */
  size?: IconSize;
  className?: string;
}

/**
 * A decorative Lucide icon: `currentColor`, hidden from assistive technology (the control around it carries the
 * name). `nonScalingStroke` is Lucide's replacement for `absoluteStrokeWidth`: the stroke stays 1.75 px at every size.
 */
export function Icon({ icon: Glyph, size = 16, className }: IconProps) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      nonScalingStroke
      className={cx('shrink-0', SIZE[size], STROKE, className)}
    />
  );
}
