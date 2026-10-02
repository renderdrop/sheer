import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { BUTTON_SIZES, BUTTON_VARIANTS, CONTROL_BASE, type ButtonSize, type ButtonVariant } from './controlStyles';
import { cx } from './cx';
import { Icon } from './Icon';
import { cancelClick, withoutActions } from './softDisabled';

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** One primary per view (DESIGN 3.1). Default `secondary`. */
  variant?: ButtonVariant;
  /** `sm` 24, `md` 32, `lg` 40 (the empty-state Open button only). Default `md`. */
  size?: ButtonSize;
  /** Optional leading icon, 16 px. */
  icon?: LucideIcon;
  /** The label. */
  children: ReactNode;
  /**
   * With `disabled`: keep the button focusable and mark it `aria-disabled` instead of removing it from the tab order.
   * Use inside toolbars, menus and tablists (DESIGN 3.0).
   */
  focusableWhenDisabled?: boolean;
}

/** Text button (DESIGN 3.1). Keys: Enter and Space, native. Extra `className` is for layout (margin, flex), not looks. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  disabled = false,
  focusableWhenDisabled = false,
  className,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const soft = disabled && focusableWhenDisabled;
  return (
    <button
      {...(soft ? withoutActions(rest) : rest)}
      type={type}
      disabled={disabled && !soft}
      aria-disabled={soft ? true : undefined}
      onClick={soft ? cancelClick : onClick}
      className={cx(CONTROL_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
    >
      {icon !== undefined && <Icon icon={icon} />}
      {children}
    </button>
  );
}
