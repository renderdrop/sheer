import { Check } from 'lucide-react';
import type { CSSProperties, ComponentProps } from 'react';

import { cx } from './cx';
import { Icon } from './Icon';

export interface SwatchProps extends Omit<ComponentProps<'button'>, 'role' | 'aria-checked' | 'children' | 'style'> {
  /** Accessible name (colour name). */
  label: string;
  checked: boolean;
  /** Fill as a class (`bg-hl-solar`). A colour of the document that has no token goes in `style`. */
  fillClass?: string;
  style?: CSSProperties;
  /** Text colour of the check, for contrast on the fill. Default Ink. */
  checkClass?: string;
}

/**
 * A colour swatch (DESIGN 4, 2.7): 24 round, 1 px Stone ring; chosen = 2 px Ink ring offset 2 (`[data-swatch]` in tokens.css)
 * plus a check, so the state is never colour alone. A radio: the group (`RadioRow`, or any `role=radiogroup`) owns the keys.
 */
export function Swatch({
  label,
  checked,
  fillClass,
  style,
  checkClass = 'text-text',
  className,
  ...rest
}: SwatchProps) {
  return (
    <button
      type="button"
      {...rest}
      role="radio"
      aria-checked={checked}
      aria-label={label}
      data-swatch=""
      style={style}
      className={cx(
        'group relative flex size-swatch shrink-0 cursor-pointer items-center justify-center rounded-pill border border-control-border',
        'hover:border-text aria-disabled:cursor-not-allowed disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)',
        fillClass,
        checkClass,
        className,
      )}
    >
      <Icon icon={Check} className="invisible group-aria-checked:visible" />
    </button>
  );
}
