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
  sm: 'h-control-sm min-w-16 gap-2 rounded-sm px-2 text-sm',
  md: 'h-control-md min-w-16 gap-2 rounded-button px-3 text-md',
  lg: 'h-control-lg min-w-16 gap-2 rounded-button px-4 text-md',
};

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent not-aria-disabled:enabled:hover:bg-accent-hover not-aria-disabled:enabled:active:bg-accent-pressed ' +
    'disabled:bg-fill-disabled disabled:text-text-disabled aria-disabled:bg-fill-disabled aria-disabled:text-text-disabled',
  secondary:
    'border border-control-border bg-surface-solid text-text not-aria-disabled:enabled:hover:bg-control-hover ' +
    'not-aria-disabled:enabled:active:bg-control-pressed disabled:border-divider disabled:text-text-disabled ' +
    'aria-disabled:border-divider aria-disabled:text-text-disabled',
  ghost:
    'bg-transparent text-text not-aria-disabled:enabled:hover:bg-control-hover not-aria-disabled:enabled:active:bg-control-pressed ' +
    'disabled:text-text-disabled aria-disabled:text-text-disabled',
};

export type IconButtonVariant = 'plain' | 'toggle' | 'tool';
export type IconButtonSize = 'sm' | 'md';

/** Square for icon-only buttons; with text content (the zoom readout) the width follows the content. */
export const ICON_BUTTON_SIZES: Record<IconButtonSize, { square: string; text: string }> = {
  md: { square: 'size-control-md rounded-button', text: 'h-control-md min-w-control-md rounded-button px-2' },
  sm: { square: 'size-control-sm rounded-sm', text: 'h-control-sm min-w-control-sm rounded-sm px-1' },
};

/** The two looks a button has besides rest: `off`, and `on` (toggle: selected, tool: active fill). */
export const ICON_BUTTON_VARIANTS: Record<IconButtonVariant, { off: string; on: string }> = {
  plain: {
    off:
      'bg-transparent text-text not-aria-disabled:enabled:hover:bg-control-hover not-aria-disabled:enabled:active:bg-control-pressed ' +
      'disabled:text-text-disabled aria-disabled:text-text-disabled',
    on: '',
  },
  toggle: {
    off:
      'bg-transparent text-text not-aria-disabled:enabled:hover:bg-control-hover not-aria-disabled:enabled:active:bg-control-pressed ' +
      'disabled:text-text-disabled aria-disabled:text-text-disabled',
    on:
      `bg-selected text-text inset-ring-1 inset-ring-accent ${SELECTED_FORCED_COLORS} not-aria-disabled:enabled:active:bg-control-pressed ` +
      'disabled:text-text-disabled aria-disabled:text-text-disabled',
  },
  tool: {
    off:
      'bg-transparent text-text not-aria-disabled:enabled:hover:bg-control-hover not-aria-disabled:enabled:active:bg-control-pressed ' +
      'disabled:text-text-disabled aria-disabled:text-text-disabled',
    on:
      'bg-accent text-on-accent not-aria-disabled:enabled:hover:bg-accent-hover not-aria-disabled:enabled:active:bg-accent-pressed ' +
      'disabled:bg-fill-disabled disabled:text-text-disabled aria-disabled:bg-fill-disabled aria-disabled:text-text-disabled',
  },
};

export type FieldSize = 'sm' | 'md';

/**
 * The number field (DESIGN 3.7): 56 wide (`--field-width`), radius 8, a hairline control border on the solid surface,
 * numbers tabular. Disabled takes the divider border and the disabled text color. An invalid value (`aria-invalid`) takes the
 * error icon's color for the border. The focus ring is the global `:focus-visible` outline.
 */
export const FIELD_BASE =
  'w-field shrink-0 rounded-sm border border-control-border bg-surface-solid px-2 text-text tabular-nums ' +
  'disabled:border-divider disabled:text-text-disabled aria-invalid:border-error-icon';

/** `sm` 24 high in the slider's row, `md` 32 high in a form (a popover). */
export const FIELD_SIZES: Record<FieldSize, string> = {
  sm: 'h-control-sm text-sm',
  md: 'h-control-md text-md',
};

/** The pill badge (DESIGN 1.10): "Edited", "Form" and the shortcut chip share it, so none can lose its fill. */
export const PILL =
  'inline-flex h-pill shrink-0 items-center rounded-pill bg-tile px-2 text-xs text-tile-icon inset-ring-1 inset-ring-control-border';
