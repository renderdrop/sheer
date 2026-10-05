import type { KeyboardEvent } from 'react';

import { CONTROL_BASE } from '../../components/controlStyles';
import { cx } from '../../components/cx';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';

export interface SegmentOption<Value extends string> {
  value: Value;
  /** The segment's text, already translated. */
  label: string;
}

export interface SegmentedControlProps<Value extends string> {
  /** The id of the element that names the group (a visible label), for `aria-labelledby`. */
  labelledBy: string;
  value: Value;
  options: readonly SegmentOption<Value>[];
  onChange: (value: Value) => void;
}

/** Up and Down move like Left and Right in a radio group (APG), so a vertical gesture works too. */
const AS_HORIZONTAL: Readonly<Record<string, string>> = { ArrowUp: 'ArrowLeft', ArrowDown: 'ArrowRight' };

/**
 * A segmented control for a setting with a few exclusive values (DESIGN 3.13): a radio group drawn as equal-width segments,
 * the chosen one in the selected look (DESIGN 3.0) and every segment with the hover and pressed states of a toggle button
 * (`ICON_BUTTON_VARIANTS.toggle`). Roving focus like the other widgets: only the chosen segment is a tab stop; the arrow
 * keys move to the next segment, wrapping, and choose it as they go (the choice is the focus, as for native radio buttons);
 * Home and End jump. Choosing the segment that is already chosen does nothing.
 *
 * Concentric radii: the track is `--radius-button` with 4 px padding, so the segments are `--radius-sm`.
 */
export function SegmentedControl<Value extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: SegmentedControlProps<Value>) {
  const hasChosen = options.some((option) => option.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const group = event.currentTarget;
    if (!isOwnEvent(group, event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const segments = itemsOf(group, '[role="radio"]');
    const current = segments.findIndex((segment) => segment.contains(event.target as Node));
    const key = AS_HORIZONTAL[event.key] ?? event.key;
    const target = rovingTarget(key, current, segments.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    const next = segments[target];
    if (next === undefined) return;
    next.focus();
    const chosen = options.find((option) => option.value === next.dataset.value);
    if (chosen !== undefined && chosen.value !== value) onChange(chosen.value);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      className="flex rounded-md bg-subtle p-half"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            tabIndex={selected || (!hasChosen && index === 0) ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={cx(
              CONTROL_BASE,
              // The segmented look of DESIGN v2 §4 (as `Segmented`): the chosen segment White with a Stone border, the others muted.
              'h-control-sm min-w-0 flex-1 basis-0 rounded-sm border px-3 text-md',
              selected
                ? 'border-control-border bg-surface font-medium text-text forced-colors:border-accent'
                : 'border-transparent font-normal text-text-muted not-aria-disabled:enabled:hover:text-text',
            )}
          >
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
