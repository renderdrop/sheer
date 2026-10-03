import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { Tooltip } from '../../components';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';

export interface RadioOption<Value extends string | number> {
  value: Value;
  /** The accessible name and the tooltip. */
  label: string;
  /** Class names and content of the radio itself. */
  className: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** Extra attribute `data-swatch` for colour swatches (forced-colors rules). */
  swatch?: boolean;
}

export interface RadioRowProps<Value extends string | number> {
  /** The id of the element that names the group. */
  labelledBy: string;
  /** The checked option, or `null` when none is (mixed values, or a value that is not among the options). */
  value: Value | null;
  options: readonly RadioOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A radio group of small buttons (DESIGN 3.24: swatches, stroke presets, line ends). One tab stop; the arrow keys move to the next
 * option, wrapping, and choose it as they go (APG radio group); Home and End jump. With none checked the first option is the tab stop.
 */
export function RadioRow<Value extends string | number>({
  labelledBy,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: RadioRowProps<Value>) {
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
    if (next === undefined) return;
    next.focus();
    const option = options[target];
    if (option !== undefined && option.value !== value) onChange(option.value);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled ? true : undefined}
      onKeyDown={onKeyDown}
      className={className}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <Tooltip key={option.value} label={option.label} side="bottom">
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={option.label}
              aria-disabled={disabled ? true : undefined}
              data-swatch={option.swatch === true ? '' : undefined}
              tabIndex={checked || (!hasChecked && index === 0) ? 0 : -1}
              onClick={() => {
                if (!disabled && !checked) onChange(option.value);
              }}
              style={option.style}
              className={option.className}
            >
              {option.children}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
