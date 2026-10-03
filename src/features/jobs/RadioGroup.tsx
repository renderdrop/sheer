import type { KeyboardEvent, ReactNode } from 'react';

import { PRESS_MOTION, SELECTED_FORCED_COLORS } from '../../components/controlStyles';
import { cx } from '../../components/cx';
import { isOwnEvent, itemsOf, rovingTarget, type Orientation } from '../../components/roving';

export interface RadioOption<Value extends string> {
  value: Value;
  /** Accessible name; the content is the visible label. */
  label: string;
  content: ReactNode;
  describedBy?: string;
}

export interface RadioGroupProps<Value extends string> {
  label: string;
  value: Value;
  options: readonly RadioOption<Value>[];
  onChange: (value: Value) => void;
  orientation: Orientation;
  /** `segmented`: equal-width 32 high segments (DESIGN 3.13). `rows`: tall rows with a selected fill (DESIGN 3.31). `plain`: one-line rows. */
  look: 'segmented' | 'rows' | 'plain';
  className?: string;
  disabled?: boolean;
}

const LOOKS = {
  segmented: 'h-control-md min-w-0 flex-1 rounded-button px-1 text-md font-semibold',
  rows: 'min-h-8 w-full flex-col items-stretch justify-center rounded-card p-1-5 text-start',
  plain: 'min-h-control-md w-full justify-start rounded-button px-1 text-start text-md',
} as const;

/**
 * A radio group with roving focus: one tab stop, the arrows move and choose (selection follows focus), Home and End jump.
 * The segmented control of the split dialog and the preset rows of the compress dialog are this.
 */
export function RadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
  orientation,
  look,
  className,
  disabled = false,
}: RadioGroupProps<Value>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const group = event.currentTarget;
    if (disabled || !isOwnEvent(group, event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const radios = itemsOf(group, '[role="radio"]');
    const current = radios.findIndex((radio) => radio.contains(event.target as Node));
    // Both axes work: a segmented control also answers Up/Down, a list also Left/Right.
    const key =
      orientation === 'horizontal'
        ? event.key === 'ArrowUp'
          ? 'ArrowLeft'
          : event.key === 'ArrowDown'
            ? 'ArrowRight'
            : event.key
        : event.key === 'ArrowLeft'
          ? 'ArrowUp'
          : event.key === 'ArrowRight'
            ? 'ArrowDown'
            : event.key;
    const target = rovingTarget(key, current, radios.length, { orientation, wrap: true });
    if (target === null) return;
    event.preventDefault();
    radios[target]?.focus();
    const next = options[target];
    if (next !== undefined) onChange(next.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      className={cx('flex', orientation === 'vertical' ? 'flex-col gap-1' : 'gap-0-5', className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={look === 'segmented' ? option.label : undefined}
            aria-describedby={option.describedBy}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cx(
              'relative flex cursor-pointer select-none items-center justify-center border border-transparent',
              PRESS_MOTION,
              'disabled:cursor-not-allowed disabled:text-text-disabled',
              LOOKS[look],
              selected
                ? `bg-selected text-text inset-ring-1 inset-ring-accent ${SELECTED_FORCED_COLORS}`
                : 'bg-transparent text-text not-disabled:hover:bg-control-hover not-disabled:active:bg-control-pressed',
              'not-disabled:active:scale-(--scale-press)',
            )}
          >
            {option.content}
          </button>
        );
      })}
    </div>
  );
}
