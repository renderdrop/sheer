import type { ComponentProps } from 'react';

import { cx } from './cx';

export interface ToggleProps extends Omit<ComponentProps<'button'>, 'role' | 'aria-checked' | 'children'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * A switch (DESIGN 4, 2.4): 36 x 20 pill. Off: Sand track, Stone border, Text-secondary knob. On: Ink border and knob.
 * The name comes from `aria-label` or `aria-labelledby`. Space and Enter toggle (native button).
 */
export function Toggle({ checked, onCheckedChange, className, disabled, onClick, ...rest }: ToggleProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-pill border p-0',
        'transition-[background-color,border-color] duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)',
        checked ? 'border-text bg-accent' : 'border-control-border bg-subtle not-disabled:hover:bg-pressed',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'pointer-events-none block size-3 rounded-pill transition-[translate] duration-fast',
          checked ? 'translate-x-4 bg-text' : 'translate-x-half bg-text-muted',
        )}
      />
    </button>
  );
}
