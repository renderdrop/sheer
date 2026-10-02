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

/** Layout and motion of every control: color transitions ease out, the press scale uses the spring curve. */
export const CONTROL_BASE =
  'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap font-semibold ' +
  'transition-[background-color,color,border-color,box-shadow,scale] ' +
  '[transition-timing-function:var(--ease-out),var(--ease-out),var(--ease-out),var(--ease-out),var(--ease-spring)] ' +
  'not-aria-disabled:enabled:active:scale-(--scale-press) disabled:cursor-not-allowed aria-disabled:cursor-not-allowed';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** `min-w-8` is 64 px: the spacing token `--space-8` (DESIGN 3.1 minimum width). */
export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-control-sm min-w-8 gap-1 rounded-sm px-1 text-sm',
  md: 'h-control-md min-w-8 gap-1 rounded-button px-1-5 text-md',
  lg: 'h-control-lg min-w-8 gap-1 rounded-button px-2 text-md',
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
  md: { square: 'size-control-md rounded-button', text: 'h-control-md min-w-control-md rounded-button px-1' },
  sm: { square: 'size-control-sm rounded-sm', text: 'h-control-sm min-w-control-sm rounded-sm px-0-5' },
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
      `bg-selected text-text-accent inset-ring-1 inset-ring-accent ${SELECTED_FORCED_COLORS} not-aria-disabled:enabled:active:bg-control-pressed ` +
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
