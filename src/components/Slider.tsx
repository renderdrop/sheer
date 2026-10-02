import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { cx } from './cx';
import { Field } from './Field';

/** Number of decimals in the decimal notation of `value` (0.25 has 2). */
function decimalsOf(value: number): number {
  const [, fraction = ''] = String(value).split('.');
  return fraction.length;
}

/** `value` clamped to [min, max] and rounded to the nearest multiple of `step` from `min`, without float noise. */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((clamped - min) / step) * step;
  const decimals = Math.max(decimalsOf(step), decimalsOf(min));
  return Math.min(max, Number(snapped.toFixed(decimals)));
}

export interface SliderProps {
  /** Visible label, also the accessible name of the slider and the field. */
  label: string;
  /** Hide the label visually; it stays the accessible name. */
  hideLabel?: boolean;
  value: number;
  /** Called on every change: key, drag, or an accepted number typed into the field. */
  onValueChange: (value: number) => void;
  /** Called once when a key press, a drag or the field settles on a value. */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Unit for `aria-valuetext` and the field ("%"). */
  unit?: string;
  /** Text of a value for `aria-valuetext` and the field; overrides `unit`. */
  format?: (value: number) => string;
  /** Reads the field's text; `null` rejects it. Default: the leading number, comma or point. */
  parse?: (text: string) => number | null;
  disabled?: boolean;
  className?: string;
}

const defaultParse = (text: string): number | null => {
  const value = Number.parseFloat(text.trim().replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

// Size of DESIGN 3.7: the track is at least 120 wide (`--slider-min`); the number field is `Field`, 56 wide.
const TRACK_MIN = 'min-w-slider-min';

/**
 * Slider with its numeric field (DESIGN 3.7; the field is always there, WCAG 2.5.7). Keys on the thumb: arrows step,
 * Shift multiplies by 10, PageUp and PageDown move 10 % of the range, Home and End jump. In the field Enter commits
 * (leaving it commits too) and Esc reverts. Dragging anywhere on the 24 px high track moves the thumb.
 */
export function Slider({
  label,
  hideLabel = false,
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  unit,
  format,
  parse = defaultParse,
  disabled = false,
  className,
}: SliderProps) {
  const labelId = useId();
  const fieldId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const text = (current: number) => (format ?? ((v) => (unit !== undefined ? `${v} ${unit}` : String(v))))(current);
  const percent = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;

  const change = (raw: number, commit: boolean) => {
    const next = snapToStep(raw, min, max, step);
    if (next !== value) onValueChange(next);
    if (commit) onValueCommit?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const unitStep = event.shiftKey ? step * 10 : step;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + unitStep;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - unitStep;
        break;
      case 'PageUp':
        next = value + (max - min) / 10;
        break;
      case 'PageDown':
        next = value - (max - min) / 10;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    change(next, true);
  };

  const fromPointer = (clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return min + ratio * (max - min);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    setIsDragging(true);
    thumbRef.current?.focus();
    const raw = fromPointer(event.clientX);
    if (raw !== null) change(raw, false);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const raw = fromPointer(event.clientX);
    if (raw !== null) change(raw, false);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setIsDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    const raw = fromPointer(event.clientX);
    if (raw !== null) change(raw, true);
    else onValueCommit?.(value);
  };

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = parse(draft);
    setDraft(null);
    if (parsed !== null) change(parsed, true);
  };

  return (
    <div className={cx('flex items-center gap-1-5', className)}>
      <label
        id={labelId}
        htmlFor={fieldId}
        className={cx(
          'text-sm font-semibold',
          hideLabel ? 'sr-only' : 'shrink-0',
          disabled ? 'text-text-disabled' : 'text-text',
        )}
      >
        {label}
      </label>
      <div
        className={`group relative flex h-control-sm flex-1 touch-none items-center px-1 ${TRACK_MIN} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div ref={trackRef} className="relative h-0-5 w-full rounded-pill bg-track">
          <div
            aria-hidden="true"
            className={`absolute inset-y-0 start-0 rounded-pill ${disabled ? 'bg-text-disabled' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
          <div
            ref={thumbRef}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-labelledby={labelId}
            aria-orientation="horizontal"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={text(value)}
            aria-disabled={disabled ? true : undefined}
            data-dragging={isDragging ? 'true' : undefined}
            onKeyDown={onKeyDown}
            // Thumb: 16 px white disc with a hairline border and the level-1 shadow. It grows by `--scale-thumb` on hover
            // and drag; reduced motion sets that token to 1, so the thumb stays still without a branch here.
            className={cx(
              'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-pill border bg-page shadow-1',
              'transition-[scale] ease-spring',
              disabled
                ? 'border-text-disabled'
                : 'border-control-border group-hover:scale-(--scale-thumb) data-[dragging=true]:scale-(--scale-thumb)',
            )}
            style={{ insetInlineStart: `${percent}%` }}
          />
        </div>
      </div>
      <Field
        size="sm"
        align="end"
        id={fieldId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft ?? text(value)}
        disabled={disabled}
        data-keep-escape={draft !== null ? '' : undefined}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitDraft();
          } else if (event.key === 'Escape' && draft !== null) {
            event.preventDefault();
            setDraft(null);
          }
        }}
      />
    </div>
  );
}
