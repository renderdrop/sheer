import type { KeyboardEvent } from 'react';

import { cx } from './cx';
import { isOwnEvent, itemsOf, rovingTarget } from './roving';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

export interface SegmentedProps<Value extends string> {
  /** `aria-label` of the group. */
  label: string;
  value: Value;
  options: readonly SegmentedOption<Value>[];
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Segmented control (DESIGN 4, 2.10): Sand track, radius md, padding 2; segments 32 high, radius sm. The active one is
 * White with a Stone border and Ink 500. A radiogroup: one tab stop, arrows move and choose (wrapping), Home and End jump.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  className,
}: SegmentedProps<Value>) {
  const hasChecked = options.some((option) => option.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const group = event.currentTarget;
    if (disabled || !isOwnEvent(group, event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const radios = itemsOf(group, '[role="radio"]');
    const current = radios.findIndex((radio) => radio.contains(event.target as Node));
    const key = event.key === 'ArrowUp' ? 'ArrowLeft' : event.key === 'ArrowDown' ? 'ArrowRight' : event.key;
    const target = rovingTarget(key, current, radios.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    const next = radios[target];
    const option = options[target];
    if (next === undefined || option === undefined) return;
    next.focus();
    if (option.disabled !== true && option.value !== value) onValueChange(option.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled ? true : undefined}
      onKeyDown={onKeyDown}
      className={cx('inline-flex rounded-md bg-subtle p-half', disabled && 'opacity-(--opacity-disabled)', className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const off = disabled || option.disabled === true;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={off ? true : undefined}
            tabIndex={checked || (!hasChecked && index === 0) ? 0 : -1}
            onClick={() => {
              if (!off && !checked) onValueChange(option.value);
            }}
            className={cx(
              'inline-flex h-control-sm min-w-0 flex-1 cursor-pointer items-center justify-center rounded-sm border px-3 text-md',
              'transition-[background-color,color,border-color] duration-fast aria-disabled:cursor-not-allowed',
              checked
                ? 'border-control-border bg-surface-solid font-medium text-text'
                : 'border-transparent font-normal text-text-muted not-aria-disabled:hover:text-text',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
