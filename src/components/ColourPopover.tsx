import { Check, Plus } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

import { useT } from '../i18n';
import { MIN_STROKE_CONTRAST, contrastOnWhite, parseHex, sameColour, toHex, type Rgb3 } from './colour';
import { FIELD_BASE, FIELD_SIZES } from './controlStyles';
import { cx } from './cx';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { Popover } from './Popover';
import { itemsOf } from './roving';
import { Swatch } from './Swatch';
import { Tooltip } from './Tooltip';

/** One colour of the palette grid: the model's bytes, its name, and the token classes (`bg-stroke-mint`) that paint it. */
export interface ColourEntry {
  id: string;
  rgb: Rgb3;
  label: string;
  fillClass: string;
  checkClass?: string;
}

export interface ColourPopoverProps {
  /** The palette of the swatch row this belongs to (strokes or highlights). */
  palette: readonly ColourEntry[];
  /** Recently used custom colours, newest first, at most 8 (the caller keeps the list). */
  recent: readonly Rgb3[];
  /** The colour the control now has; `null` for a mixed selection. */
  value: Rgb3 | null;
  /** A palette or recent swatch was chosen. */
  onPick: (rgb: Rgb3) => void;
  /** Apply on a valid hex colour: the caller puts it first in the recent list and uses it. */
  onApply: (rgb: Rgb3) => void;
  /** Strokes need 3:1 on white: a lighter colour gets a caption (not a block). Highlights are fills and need none. */
  stroke?: boolean;
  disabled?: boolean;
  /** Extra attributes of the trigger swatch (the mini bar marks it as a stop of its roving focus). */
  triggerAttrs?: Record<string, string>;
}

const COLUMNS = 6;
/** The look of a colour that has no token: a colour of the user's, the one thing that is set inline. */
const css = (rgb: Rgb3): string => `color(srgb ${rgb[0] / 255} ${rgb[1] / 255} ${rgb[2] / 255})`;

/**
 * "More colours" (DESIGN 3.5 B5): a 24 swatch with a plus that opens a 240 wide popover: the palette grid (6 per row), "Recently used"
 * (up to 8, newest first), and a hex field with preview and Apply. The field takes 3 or 6 digits with or without "#", shows a live
 * preview while valid and an error state otherwise; Apply is off until it is valid. Arrow keys move over the swatches (one tab stop),
 * Enter chooses, Tab goes on to the field, Esc closes and gives focus back.
 */
export function ColourPopover({
  palette,
  recent,
  value,
  onPick,
  onApply,
  stroke = true,
  disabled = false,
  triggerAttrs,
}: ColourPopoverProps) {
  const t = useT();
  return (
    <Popover
      label={t('color.more')}
      disabled={disabled}
      trigger={(trigger) => (
        <Tooltip label={t('color.more')}>
          <button
            {...trigger}
            {...triggerAttrs}
            type="button"
            aria-label={t('color.more')}
            aria-disabled={disabled ? true : undefined}
            data-colour-more=""
            className={cx(
              'relative mx-1 flex size-swatch shrink-0 cursor-pointer items-center justify-center rounded-pill border border-control-border bg-surface text-text',
              'hover:border-text aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)',
              "before:absolute before:-inset-1 before:content-['']",
            )}
          >
            <Icon icon={Plus} />
          </button>
        </Tooltip>
      )}
    >
      {(api) => (
        <ColourPanel
          palette={palette}
          recent={recent}
          value={value}
          stroke={stroke}
          onPick={(rgb) => {
            onPick(rgb);
            api.close('select');
          }}
          onApply={(rgb) => {
            onApply(rgb);
            api.close('select');
          }}
        />
      )}
    </Popover>
  );
}

/** At most this many recent custom colours follow the palette (DESIGN 3.9 Q4): one more row of six at most. */
export const RECENT_IN_POPOVER = 6;

function ColourPanel({
  palette,
  recent,
  value,
  stroke,
  onPick,
  onApply,
}: Pick<ColourPopoverProps, 'palette' | 'recent' | 'value' | 'onPick' | 'onApply'> & { stroke: boolean }) {
  const t = useT();
  const hexId = useId();
  const noteId = useId();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const parsed = parseHex(text);
  // An empty or incomplete field is only an error once Enter or leaving the field said it was meant (DESIGN 3.9 Q4).
  const invalid = touched && text.trim() !== '' && parsed === null;
  const low = stroke && parsed !== null && contrastOnWhite(parsed) < MIN_STROKE_CONTRAST;
  const shown = recent.slice(0, RECENT_IN_POPOVER);

  // One tab stop over the swatches: the checked one, else the first; the arrows move.
  const all = [...palette.map((entry) => entry.rgb), ...shown];
  const checked = value === null ? -1 : all.findIndex((rgb) => sameColour(rgb, value));
  const [stop, setStop] = useState(Math.max(0, checked));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const swatches = itemsOf(event.currentTarget, '[data-colour-swatch]');
    const at = swatches.findIndex((item) => item === event.target);
    if (at < 0) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(swatches.length - 1, at + step));
    setStop(next);
    swatches[next]?.focus();
  };

  const apply = () => {
    setTouched(true);
    if (parsed !== null) onApply(parsed);
  };

  const swatch = (rgb: Rgb3, index: number, label: string, fillClass?: string, checkClass?: string) => (
    <div key={`${index}-${toHex(rgb)}`} className="flex size-8 items-center justify-center">
      <Tooltip label={label}>
        <Swatch
          data-colour-swatch=""
          tabIndex={index === stop ? 0 : -1}
          label={label}
          checked={value !== null && sameColour(value, rgb)}
          fillClass={fillClass}
          checkClass={checkClass}
          style={fillClass === undefined ? { backgroundColor: css(rgb) } : undefined}
          onFocus={() => setStop(index)}
          onClick={() => onPick(rgb)}
        />
      </Tooltip>
    </div>
  );

  return (
    <div className="flex w-(--colour-popover-inner) flex-col gap-3" onKeyDown={onKeyDown}>
      <div role="radiogroup" aria-label={t('minibar.colour')} className="grid grid-cols-6 justify-items-center">
        {palette.map((entry, index) => swatch(entry.rgb, index, entry.label, entry.fillClass, entry.checkClass))}
        {shown.map((rgb, index) => swatch(rgb, palette.length + index, `#${toHex(rgb)}`))}
      </div>
      <div className="flex flex-col gap-1">
        <div className="relative w-full">
          <span
            aria-hidden="true"
            data-colour-preview=""
            className="absolute start-2 top-1/2 size-4 -translate-y-1/2 rounded-pill border border-control-border"
            style={{ backgroundColor: parsed === null ? 'transparent' : css(parsed) }}
          />
          <span aria-hidden="true" className="absolute start-8 top-1/2 -translate-y-1/2 text-md text-text-muted">
            #
          </span>
          <input
            id={hexId}
            value={text}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('color.hex')}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid || low ? noteId : undefined}
            onChange={(event) => {
              // A pasted "#1F9E6A" or " 1f9e6a " is the six digits.
              setText(event.target.value.replace(/\s+/g, '').replace(/^#+/, '').slice(0, 6));
              setTouched(false);
            }}
            onBlur={() => {
              setText((old) => old.toUpperCase());
              setTouched(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                apply();
              }
            }}
            className={cx(
              FIELD_BASE.replace('w-field ', '').replace('px-3', ''),
              FIELD_SIZES.md,
              'w-full min-w-0 ps-12 pe-8 uppercase',
            )}
          />
          <IconButton
            icon={Check}
            data-adornment=""
            label={t('color.apply')}
            size="sm"
            disabled={parsed === null}
            focusableWhenDisabled
            onClick={apply}
            className="absolute end-1 top-1/2 size-6! -translate-y-1/2"
          />
        </div>
        {(invalid || low) && (
          <p
            id={noteId}
            role={invalid ? 'alert' : undefined}
            className={cx('t-caption m-0', invalid ? 'text-error-text' : 'text-text-muted')}
          >
            {invalid ? t('color.hexInvalid') : t('color.lowContrast')}
          </p>
        )}
      </div>
    </div>
  );
}
