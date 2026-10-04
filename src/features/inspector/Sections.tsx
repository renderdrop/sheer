import { Check, ChevronDown } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { LineEnd, Rgb } from '../../api/annotations';
import { Field, Icon, IconButton, Menu, Slider } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { PALETTE, paletteEntry, rgbToCss } from './palette';
import { RadioRow, type RadioOption } from './RadioRow';
import type { Shared } from './properties';
import { FONT_SIZE_RANGE, FONT_SIZES, OPACITY_RANGE, STROKE_PRESETS, type AnnotationStyle } from './style';

export interface SectionProps {
  disabled: boolean;
  onChange: (change: Partial<AnnotationStyle>) => Promise<void>;
}

/** A section: its label (meta, 600) over its control, and the "Mixed" cue beside the label when the selection differs. */
function Labelled({
  label,
  mixed,
  children,
}: {
  label: string;
  mixed?: boolean;
  children: (labelId: string) => ReactNode;
}) {
  const t = useT();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span id={labelId} className="text-sm font-semibold text-text-muted">
          {label}
        </span>
        {mixed === true && <span className="text-sm text-text-muted">{t('inspector.mixed')}</span>}
      </div>
      {children(labelId)}
    </div>
  );
}

const SWATCH =
  'group relative flex size-swatch shrink-0 cursor-pointer items-center justify-center rounded-pill border border-control-border aria-disabled:cursor-not-allowed';

function swatchOption(rgb: Rgb, label: string, bg: string | null, check: string): RadioOption<string> {
  return {
    value: rgb.join(','),
    label,
    swatch: true,
    className: cx(SWATCH, bg ?? undefined, check),
    // A colour from the file is data, not a design colour: it can only be set inline.
    style: bg === null ? { backgroundColor: rgbToCss(rgb) } : undefined,
    children: <Icon icon={Check} size={16} className="invisible group-aria-checked:visible" />,
  };
}

function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function RecentRow({
  recent,
  current,
  disabled,
  onChoose,
}: {
  recent: readonly Rgb[];
  current: string | null;
  disabled: boolean;
  onChoose: (value: string) => void;
}) {
  const t = useT();
  return (
    <Labelled label={t('inspector.recent')}>
      {(labelId) => (
        <RadioRow
          labelledBy={labelId}
          value={current}
          disabled={disabled}
          onChange={onChoose}
          className="flex flex-wrap gap-2"
          options={recent.map((rgb) =>
            // Ink on a light colour of the file, white on a dark one.
            swatchOption(
              rgb,
              t('inspector.recentColour', { r: rgb[0], g: rgb[1], b: rgb[2] }),
              null,
              luminance(rgb) > 0.4 ? 'text-annot-black' : 'text-page',
            ),
          )}
        />
      )}
    </Labelled>
  );
}

export function ColourSection({
  colour,
  recent,
  disabled,
  onChange,
  only,
}: SectionProps & {
  colour: Shared<Rgb>;
  recent: readonly Rgb[];
  /** Offer only these palette colours (ink of a signature: black or blue, DESIGN 3.33). */
  only?: readonly string[];
}) {
  const t = useT();
  const current = colour.value === null ? null : colour.value.join(',');
  const choose = (value: string) => {
    const [r, g, b] = value.split(',').map(Number);
    if (r !== undefined && g !== undefined && b !== undefined) void onChange({ color: [r, g, b] });
  };
  const recentRow = recent.filter((rgb) => paletteEntry(rgb) === undefined);
  return (
    <Labelled label={t('inspector.colour')} mixed={colour.mixed}>
      {(labelId) => (
        <>
          <RadioRow
            labelledBy={labelId}
            value={current}
            disabled={disabled}
            onChange={choose}
            className="flex flex-wrap gap-2"
            options={PALETTE.filter((entry) => only === undefined || only.includes(entry.id)).map((entry) =>
              swatchOption(entry.rgb, t(entry.nameKey), entry.bg, entry.check),
            )}
          />
          {only === undefined && recentRow.length > 0 && (
            <RecentRow recent={recentRow} current={current} disabled={disabled} onChoose={choose} />
          )}
        </>
      )}
    </Labelled>
  );
}

const SEGMENT =
  'flex h-control-md min-w-0 flex-1 basis-0 cursor-pointer items-center justify-center rounded-sm text-md aria-disabled:cursor-not-allowed ' +
  'hover:bg-control-hover aria-checked:bg-selected aria-checked:text-text';
const SEGMENTS = 'flex gap-1 rounded-button border border-divider p-1';

export function StrokeSection({ width, disabled, onChange }: SectionProps & { width: Shared<number> }) {
  const t = useT();
  return (
    <Labelled label={t('inspector.stroke')} mixed={width.mixed}>
      {(labelId) => (
        <RadioRow
          labelledBy={labelId}
          value={width.value === null ? null : String(width.value)}
          disabled={disabled}
          onChange={(value) => void onChange({ width: Number(value) })}
          className={SEGMENTS}
          options={STROKE_PRESETS.map((points) => ({
            value: String(points),
            label: t('inspector.strokeOption', { n: points }),
            className: SEGMENT,
            children: (
              <svg viewBox="0 0 24 8" aria-hidden="true" focusable="false" className="w-full max-w-swatch">
                <line x1="2" x2="22" y1="4" y2="4" stroke="currentColor" strokeWidth={points} strokeLinecap="round" />
              </svg>
            ),
          }))}
        />
      )}
    </Labelled>
  );
}

const LINE_ENDS: readonly {
  value: LineEnd;
  labelKey: 'inspector.lineEnd.none' | 'inspector.lineEnd.open' | 'inspector.lineEnd.closed';
}[] = [
  { value: 'none', labelKey: 'inspector.lineEnd.none' },
  { value: 'openArrow', labelKey: 'inspector.lineEnd.open' },
  { value: 'closedArrow', labelKey: 'inspector.lineEnd.closed' },
];

export function LineEndSection({ head, disabled, onChange }: SectionProps & { head: Shared<LineEnd> }) {
  const t = useT();
  return (
    <Labelled label={t('inspector.lineEnd')} mixed={head.mixed}>
      {(labelId) => (
        <RadioRow
          labelledBy={labelId}
          value={head.value}
          disabled={disabled}
          onChange={(value) => void onChange({ head: value })}
          className={SEGMENTS}
          options={LINE_ENDS.map((end) => ({
            value: end.value,
            label: t(end.labelKey),
            className: cx(SEGMENT, 'px-2'),
            children: <span className="truncate">{t(end.labelKey)}</span>,
          }))}
        />
      )}
    </Labelled>
  );
}

export function OpacitySection({ opacity, disabled, onChange }: SectionProps & { opacity: Shared<number> }) {
  const t = useT();
  const actual = Math.round((opacity.value ?? 1) * 100);
  // The value while the thumb is dragged: shown at once, committed once on release (one undo step).
  const [draft, setDraft] = useState<{ from: number; value: number } | null>(null);
  const shown = draft !== null && draft.from === actual ? draft.value : actual;
  return (
    <Labelled label={t('inspector.opacity')} mixed={opacity.mixed}>
      {() => (
        <Slider
          label={t('inspector.opacity')}
          hideLabel
          value={shown}
          min={OPACITY_RANGE.min * 100}
          max={OPACITY_RANGE.max * 100}
          step={OPACITY_RANGE.step * 100}
          unit="%"
          disabled={disabled}
          onValueChange={(value) => setDraft({ from: actual, value })}
          onValueCommit={(value) => {
            setDraft({ from: actual, value });
            void onChange({ opacity: value / 100 }).finally(() => setDraft(null));
          }}
        />
      )}
    </Labelled>
  );
}

export function FontSizeSection({ fontSize, disabled, onChange }: SectionProps & { fontSize: Shared<number> }) {
  const t = useT();
  const actual = fontSize.value === null ? '' : String(fontSize.value);
  // The text being typed; it belongs to the value it was typed over, so a new value (the command answered, Undo) drops it.
  const [typed, setTyped] = useState<{ over: string; text: string } | null>(null);
  const text = typed !== null && typed.over === actual ? typed.text : null;
  const setText = (next: string | null) => setTyped(next === null ? null : { over: actual, text: next });

  const commit = (raw: string) => {
    setText(null);
    const parsed = Number.parseFloat(raw.trim().replace(',', '.'));
    if (!Number.isFinite(parsed)) return;
    const next = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.round(parsed * 2) / 2));
    if (String(next) !== actual) void onChange({ fontSize: next });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(event.currentTarget.value);
    } else if (event.key === 'Escape' && text !== null) {
      setText(null);
    }
  };

  return (
    <Labelled label={t('inspector.fontSize')} mixed={fontSize.mixed}>
      {() => (
        <div className="flex items-center gap-1">
          <Field
            size="md"
            align="end"
            inputMode="decimal"
            aria-label={t('inspector.fontSize')}
            placeholder={fontSize.mixed ? t('inspector.mixed') : undefined}
            value={text ?? actual}
            disabled={disabled}
            // While there is typing to cancel, the first Esc is the field's (it reverts).
            data-keep-escape={text !== null ? '' : undefined}
            onChange={(event) => setText(event.target.value)}
            onBlur={(event) => {
              if (text !== null) commit(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className="w-field"
          />
          <Menu
            label={t('inspector.fontSizes')}
            side="bottom"
            align="start"
            disabled={disabled}
            entries={FONT_SIZES.map((size) => ({
              id: String(size),
              label: String(size),
              checked: String(size) === actual,
              onSelect: () => void onChange({ fontSize: size }),
            }))}
            trigger={(trigger) => (
              <IconButton
                {...trigger}
                size="sm"
                icon={ChevronDown}
                label={t('inspector.fontSizes')}
                focusableWhenDisabled
                disabled={disabled}
              />
            )}
          />
        </div>
      )}
    </Labelled>
  );
}
