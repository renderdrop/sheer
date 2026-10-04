/**
 * Class strings shared by Button and IconButton (DESIGN 3.0 to 3.2). Every class is a role-token utility. They are
 * written out in full, because Tailwind finds classes by scanning the source for complete names.
 *
 * Enabled-only interaction: `not-aria-disabled:enabled:` skips both ways of being disabled (the `disabled` attribute and
 * `aria-disabled`, used where a disabled control must stay focusable). `hover:` is already wrapped in `(hover: hover)`.
 * Pressed scales through `--scale-press`, which reduced motion sets to 1.
 */

/**
 * The selected look under forced colors (DESIGN 3.0 "selected / on"). Its 1 px accent ring is a box-shadow, which forced
 * colors drops, and its fill becomes Canvas, so the state would vanish. A 2 px border in the system highlight color
 * (`--color-accent` is Highlight there, `--focus-width` is the ring width) carries it instead. A border, not an outline,
 * because the focus ring is an outline and a focused selected control must show both. Outside forced colors the
 * classes do nothing.
 */
export const SELECTED_FORCED_COLORS = 'forced-colors:border-(length:--focus-width) forced-colors:border-accent';

/**
 * Hover and press response (MOTION 4.1), one spring curve: fills and colours change in --motion-fast; the press scales down
 * in fast (the active rule below) and springs back in base on release. Reduced motion resets `--scale-press` to 1, so only
 * the fill remains. Shared by buttons, toolbar items, tabs, segments and menu items.
 */
export const PRESS_MOTION =
  'transition-[background-color,color,border-color,box-shadow,scale] ' +
  '[transition-duration:var(--motion-fast),var(--motion-fast),var(--motion-fast),var(--motion-fast),var(--motion-base)] ' +
  'not-aria-disabled:active:[transition-duration:var(--motion-fast)]';

/** Layout and motion of every control. */
export const CONTROL_BASE =
  'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap font-semibold ' +
  PRESS_MOTION +
  ' not-aria-disabled:enabled:active:scale-(--scale-press) disabled:cursor-not-allowed aria-disabled:cursor-not-allowed';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** `min-w-16` is 64 px: the spacing token `--space-16` (DESIGN 3.1 minimum width). */
export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-control-sm min-w-16 gap-2 rounded-sm px-3 t-label',
  md: 'h-control-md min-w-16 gap-2 rounded-button px-4 t-label',
  lg: 'h-control-lg min-w-16 gap-2 rounded-button px-4 t-label',
};

/** Disabled (DESIGN 4): `--opacity-disabled` on the whole control, fills unchanged. */
const DISABLED = 'disabled:opacity-(--opacity-disabled) aria-disabled:opacity-(--opacity-disabled)';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: `bg-accent text-on-accent not-aria-disabled:enabled:hover:bg-accent-hover ${DISABLED}`,
  secondary: `bg-subtle text-text not-aria-disabled:enabled:hover:bg-pressed ${DISABLED}`,
  ghost: `bg-transparent text-text not-aria-disabled:enabled:hover:bg-subtle not-aria-disabled:enabled:active:bg-pressed ${DISABLED}`,
};

export type IconButtonVariant = 'plain' | 'toggle' | 'tool';
export type IconButtonSize = 'sm' | 'md';

/** Square for icon-only buttons; with text content (the zoom readout) the width follows the content. */
export const ICON_BUTTON_SIZES: Record<IconButtonSize, { square: string; text: string }> = {
  md: { square: 'size-control-md rounded-button', text: 'h-control-md min-w-control-md rounded-button px-2' },
  sm: { square: 'size-control-sm rounded-sm', text: 'h-control-sm min-w-control-sm rounded-sm px-1' },
};

const ICON_REST = `bg-transparent text-text not-aria-disabled:enabled:hover:bg-subtle not-aria-disabled:enabled:active:bg-pressed ${DISABLED}`;

/** The looks besides rest: toggle on = Sand + Ink icon; tool on = Solar fill + Ink (DESIGN 2.3). */
export const ICON_BUTTON_VARIANTS: Record<IconButtonVariant, { off: string; on: string }> = {
  plain: { off: ICON_REST, on: '' },
  toggle: {
    off: ICON_REST,
    on: `bg-subtle text-text ${SELECTED_FORCED_COLORS} not-aria-disabled:enabled:active:bg-pressed ${DISABLED}`,
  },
  tool: {
    off: ICON_REST,
    on: `bg-accent text-on-accent not-aria-disabled:enabled:hover:bg-accent-hover ${DISABLED}`,
  },
};

export type FieldSize = 'sm' | 'md';

/**
 * The text and number field (DESIGN 4, 2.9): White, radius md, padding-x 12. Border subtle on three sides, the bottom edge
 * Stone; hover turns the bottom edge Ink. Invalid (`aria-invalid`) takes the danger border. Disabled: `--opacity-disabled`.
 * The focus ring is the global `:focus-visible` ring.
 */
export const FIELD_BASE =
  'w-field shrink-0 rounded-button border border-border-subtle border-b-control-border bg-surface-solid px-3 text-text ' +
  'tabular-nums placeholder:text-text-muted not-disabled:hover:border-b-text disabled:opacity-(--opacity-disabled) ' +
  'aria-invalid:border-error-icon transition-colors [transition-duration:var(--motion-fast)]';

/** `sm` 24 high in the slider's row, `md` 32 high in a form (a popover). */
export const FIELD_SIZES: Record<FieldSize, string> = {
  sm: 'h-control-sm text-sm',
  md: 'h-control-md text-md',
};

/** The pill badge (DESIGN 1.10): "Edited", "Form" and the shortcut chip share it, so none can lose its fill. */
export const PILL =
  'inline-flex h-pill shrink-0 items-center rounded-pill bg-tile px-2 text-xs text-tile-icon inset-ring-1 inset-ring-control-border';
