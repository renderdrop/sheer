import { Lock, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { useT } from '../i18n';
import {
  CONTROL_BASE,
  ICON_BUTTON_SIZES,
  ICON_BUTTON_VARIANTS,
  type IconButtonSize,
  type IconButtonVariant,
} from './controlStyles';
import { cx } from './cx';
import { Icon, type IconSize } from './Icon';
import type { Side } from './position';
import { cancelClick, withoutActions } from './softDisabled';
import { Tooltip } from './Tooltip';

type Managed = 'children' | 'aria-label' | 'aria-pressed' | 'aria-keyshortcuts' | 'aria-description';

export interface IconButtonProps extends Omit<ComponentProps<'button'>, Managed> {
  /** The name: becomes `aria-label` and the tooltip text (DESIGN 3.2 requires both to match). */
  label: string;
  icon?: LucideIcon;
  /** Text instead of an icon, for example the zoom readout. */
  children?: ReactNode;
  /** `plain` action, `toggle` (selected look) or `tool` (accent fill when on). Default `plain`. */
  variant?: IconButtonVariant;
  /** `md` 36 or `sm` 28. Default `md`. */
  size?: IconButtonSize;
  /** Icon size: 18 by default, 20 for large tools. */
  iconSize?: IconSize;
  /** Toggle and tool state; also sets `aria-pressed`. Leave `undefined` for plain actions. */
  pressed?: boolean;
  /** The on-look without `aria-pressed`, for a menu button that stands for something active inside it. */
  active?: boolean;
  /** Tool kept after use: on-look plus a lock badge, `aria-description` and a tooltip note (DESIGN 3.3). */
  locked?: boolean;
  /** Key chip in the tooltip, formatted for the platform ("Ctrl+O"). */
  shortcut?: string;
  /** `aria-keyshortcuts` value ("Control+O Meta+O"); set it whenever the control is bound. */
  keyShortcuts?: string;
  tooltipSide?: Side;
  /** One-line explanation: the tooltip's second line and the accessible description (unless the tool is locked). */
  hint?: string;
  /** Overrides the default `aria-description` / tooltip note of a locked tool. */
  lockedDescription?: string;
  lockedNote?: string;
  /**
   * With `disabled`: stay focusable and use `aria-disabled` (toolbars, menus, tablists; DESIGN 3.0). Such a button does
   * nothing: its click, key, double-click and pointer handlers are dropped, only focus and hover observers stay.
   */
  focusableWhenDisabled?: boolean;
}

/**
 * Icon button with its tooltip (DESIGN 3.2). `aria-label` and tooltip are one `label`. `ref` and event props reach the
 * `<button>`, so a Popover trigger can be spread onto it. Extra `className` is for layout, not looks.
 */
export function IconButton({
  label,
  icon,
  children,
  variant = 'plain',
  size = 'md',
  iconSize = 18,
  pressed,
  active = false,
  locked = false,
  shortcut,
  keyShortcuts,
  tooltipSide,
  lockedDescription,
  lockedNote,
  hint,
  disabled = false,
  focusableWhenDisabled = false,
  className,
  onClick,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const t = useT();
  const soft = disabled && focusableWhenDisabled;
  const on = pressed === true || active || locked;
  const looks = ICON_BUTTON_VARIANTS[variant];
  const sizes = ICON_BUTTON_SIZES[size];

  const button = (
    <button
      {...(soft ? withoutActions(rest) : rest)}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={keyShortcuts}
      aria-description={locked ? (lockedDescription ?? t('component.locked')) : hint}
      aria-disabled={soft ? true : undefined}
      disabled={disabled && !soft}
      onClick={soft ? cancelClick : onClick}
      className={cx(
        CONTROL_BASE,
        icon !== undefined && children === undefined ? sizes.square : sizes.text,
        on && looks.on !== '' ? looks.on : looks.off,
        className,
      )}
    >
      {icon !== undefined && <Icon icon={icon} size={iconSize} />}
      {children}
      {locked && (
        // Lock glyph in the bottom-right corner, inset 2 px (half of --space-1): Ink, never accent.
        <span
          aria-hidden="true"
          className="absolute bottom-[calc(var(--space-1)/2)] end-[calc(var(--space-1)/2)] grid place-items-center text-text"
        >
          <Icon icon={Lock} size={16} />
        </span>
      )}
    </button>
  );

  return (
    <Tooltip
      label={label}
      shortcut={shortcut}
      note={locked ? (lockedNote ?? t('component.lockedNote')) : hint}
      side={tooltipSide}
    >
      {button}
    </Tooltip>
  );
}
