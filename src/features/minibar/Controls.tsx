import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  ChevronDown,
  Circle,
  Highlighter,
  MessageSquare,
  PaintBucket,
  Square,
  Strikethrough,
  Trash2,
  Underline,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { Rgb, TextAlign } from '../../api/annotations';
import {
  ColourPopover,
  Field,
  Icon,
  IconButton,
  Menu,
  Popover,
  RECENT_IN_ROW,
  Segmented,
  Swatch,
  Tooltip,
  toHex,
  type ColourEntry,
} from '../../components';
import { cx } from '../../components/cx';
import { useT, type PlainKey } from '../../i18n';
import { useRecentColours } from '../../stores/recentColours';
import { useTools } from '../../stores/tools';
import {
  BORDER_WIDTHS,
  FIRST_BORDER_COLOUR,
  FIRST_BORDER_PT,
  FIRST_FILL_COLOUR,
} from '../annotations/create/textStyle';
import { HIGHLIGHT_PALETTE, isCustomColour, PALETTES, rgbToCss, sameRgb, type PaletteName } from '../inspector/palette';
import type { Shared } from '../inspector/properties';
import { MINI_FONT_SIZES, MINI_FONT_SIZE_RANGE, MINI_OPACITIES, MINI_STROKES, type ArrowEnds } from './model';

/** Marks an element as one stop of the bar's roving focus. */
export const ITEM = { 'data-mb-item': '' } as const;

/** Every control is 32 (DESIGN v2 3.3); the IconButton's own size is the 28 of the dense toolbars. */
const SQUARE = 'size-8!';
const TEXT_BUTTON = 'h-8! min-w-8! gap-1 px-2! text-md tabular-nums';

function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

interface DisabledProps {
  disabled: boolean;
}

export function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-divider" />;
}

/**
 * The swatch row of a palette (DESIGN 3.5 B5): the palette, then up to 3 recent custom colours (the colour the selection has, if it is
 * in no palette, comes first as "Custom"), then "More colours". With a mixed selection none is checked (an empty ring). `roving` marks
 * the swatches as stops of the mini bar's roving focus; a row inside a popover is not one.
 */
export function ColourRow({
  palette,
  value,
  disabled,
  onChange,
  roving = true,
}: DisabledProps & { palette: PaletteName; value: Shared<Rgb>; onChange: (rgb: Rgb) => void; roving?: boolean }) {
  const t = useT();
  const recent = useRecentColours((state) => state.colours);
  const item = roving ? ITEM : {};
  const custom = value.value !== null && isCustomColour(value.value, palette) ? value.value : null;
  const pick = (rgb: Rgb) => {
    if (!disabled) onChange(rgb);
  };
  const customs: Rgb[] = [
    ...(custom === null ? [] : [custom]),
    ...recent.filter((rgb) => isCustomColour(rgb, palette) && (custom === null || !sameRgb(rgb, custom))),
  ].slice(0, RECENT_IN_ROW);
  const entries: ColourEntry[] = PALETTES[palette].map((entry) => ({
    id: entry.id,
    rgb: entry.rgb,
    label: t(entry.nameKey),
    fillClass: entry.bg,
    checkClass: entry.check,
  }));
  return (
    <>
      {PALETTES[palette].map((entry) => (
        <Tooltip key={entry.id} label={t(entry.nameKey)}>
          <Swatch
            {...item}
            label={t(entry.nameKey)}
            checked={value.value !== null && sameRgb(value.value, entry.rgb)}
            fillClass={entry.bg}
            checkClass={entry.check}
            aria-disabled={disabled ? true : undefined}
            onClick={() => pick(entry.rgb)}
            className="mx-1 before:absolute before:-inset-1 before:content-['']"
          />
        </Tooltip>
      ))}
      {customs.map((rgb) => {
        const label = custom !== null && sameRgb(rgb, custom) ? t('colour.custom') : `#${toHex(rgb)}`;
        return (
          <Tooltip key={toHex(rgb)} label={label}>
            <Swatch
              {...item}
              label={label}
              checked={value.value !== null && sameRgb(value.value, rgb)}
              // A colour of the user's or of a file is data, not a design colour: it can only be set inline.
              style={{ backgroundColor: rgbToCss(rgb) }}
              checkClass={luminance(rgb) > 0.4 ? 'text-ink' : 'text-page'}
              aria-disabled={disabled ? true : undefined}
              onClick={() => pick(rgb)}
              className="mx-1 before:absolute before:-inset-1 before:content-['']"
            />
          </Tooltip>
        );
      })}
      <ColourPopover
        palette={entries}
        recent={recent}
        value={value.value}
        stroke={palette !== 'highlight' && palette !== 'fill'}
        disabled={disabled}
        triggerAttrs={roving ? { 'data-mb-item': '' } : undefined}
        onPick={(rgb) => pick(rgb)}
        onApply={(rgb) => {
          useRecentColours.getState().add(rgb);
          pick(rgb);
        }}
      />
    </>
  );
}

/** The colour control of a bar: the swatch row in a group. */
export function ColourControl(
  props: DisabledProps & { palette: PaletteName; value: Shared<Rgb>; onChange: (rgb: Rgb) => void },
) {
  const t = useT();
  return (
    <div role="group" aria-label={t('minibar.colour')} className="flex items-center">
      <ColourRow {...props} />
    </div>
  );
}

export interface KindOption {
  value: string;
  icon: LucideIcon;
  labelKey: PlainKey;
}

export const MARKUP_KINDS: readonly KindOption[] = [
  { value: 'highlight', icon: Highlighter, labelKey: 'annot.type.highlight' },
  { value: 'underline', icon: Underline, labelKey: 'annot.type.underline' },
  { value: 'strikeout', icon: Strikethrough, labelKey: 'annot.type.strikeout' },
];

export const MARK_KINDS: readonly KindOption[] = [
  { value: 'check', icon: Check, labelKey: 'annot.type.check' },
  { value: 'cross', icon: X, labelKey: 'annot.type.cross' },
  { value: 'dot', icon: Circle, labelKey: 'annot.type.dot' },
];

/** The icon-only segmented control of a kind: Sand track, the chosen segment White with a Stone border (DESIGN 4, Segmented). */
export function KindControl({
  label,
  options,
  value,
  disabled,
  onChange,
}: DisabledProps & {
  label: string;
  options: readonly KindOption[];
  value: Shared<string>;
  onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md bg-subtle p-half">
      {options.map((option) => {
        const checked = value.value === option.value;
        return (
          <Tooltip key={option.value} label={t(option.labelKey)}>
            <button
              {...ITEM}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t(option.labelKey)}
              aria-disabled={disabled ? true : undefined}
              onClick={() => {
                if (!disabled && !checked) onChange(option.value);
              }}
              className={cx(
                'inline-flex size-control-sm cursor-pointer items-center justify-center rounded-sm border transition-[background-color,color,border-color] duration-fast',
                'aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)',
                checked
                  ? 'border-control-border bg-surface-solid text-text'
                  : 'border-transparent text-text-muted not-aria-disabled:hover:text-text',
              )}
            >
              <Icon icon={option.icon} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function CommentControl({ label, disabled, onOpen }: { label: string; disabled?: boolean; onOpen: () => void }) {
  return (
    <IconButton
      {...ITEM}
      icon={MessageSquare}
      label={label}
      disabled={disabled === true}
      focusableWhenDisabled
      onClick={onOpen}
      className={SQUARE}
    />
  );
}

export function DeleteControl({ label, disabled, onDelete }: DisabledProps & { label: string; onDelete: () => void }) {
  return (
    <IconButton
      {...ITEM}
      icon={Trash2}
      label={label}
      disabled={disabled}
      focusableWhenDisabled
      onClick={onDelete}
      className={SQUARE}
    />
  );
}

/** A dropdown whose trigger shows its value (tabular numbers, "–" when the selection differs). */
function Dropdown({
  label,
  disabled,
  entries,
  children,
  className,
}: DisabledProps & {
  label: string;
  entries: Parameters<typeof Menu>[0]['entries'];
  children: ReactNode;
  className?: string;
}) {
  return (
    <Menu
      label={label}
      side="bottom"
      align="start"
      disabled={disabled}
      entries={entries}
      trigger={(trigger) => (
        <IconButton
          {...trigger}
          {...ITEM}
          label={label}
          disabled={disabled}
          focusableWhenDisabled
          className={cx(TEXT_BUTTON, className)}
        >
          {children}
          <Icon icon={ChevronDown} size={16} />
        </IconButton>
      )}
    />
  );
}

const MIXED = '–';

/**
 * The font size (DESIGN 3.5 B4): a 56 wide field that takes a typed size from 6 to 144 (Enter or leaving the field applies it, a value
 * out of range is cut to it, text that is no number goes back), and a chevron that opens the steps 8 to 72.
 */
export function FontSizeControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<number>; onChange: (pt: number) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value.value === null ? '' : String(value.value));
  const commit = () => {
    const typed = Number(draft?.replace(',', '.').trim());
    setDraft(null);
    if (draft === null || draft.trim() === '' || !Number.isFinite(typed)) return;
    const size = Math.round(Math.min(MINI_FONT_SIZE_RANGE.max, Math.max(MINI_FONT_SIZE_RANGE.min, typed)) * 10) / 10;
    if (size !== value.value) onChange(size);
  };
  return (
    <div className="flex items-center">
      <Field
        {...ITEM}
        inputMode="decimal"
        aria-label={t('minibar.fontSize')}
        placeholder={MIXED}
        value={shown}
        disabled={disabled}
        align="end"
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          // The bar's roving keys are not the field's: only Enter and Esc are handled here.
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape' && draft !== null) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          } else if (event.key !== 'Tab') {
            // Left and Right edit the number, except at its ends, where they leave the field for the next control of the bar.
            const input = event.currentTarget;
            const { selectionStart: from, selectionEnd: to } = input;
            const atStart = from === 0 && to === 0 && event.key === 'ArrowLeft';
            const atEnd = from === input.value.length && to === from && event.key === 'ArrowRight';
            if (!atStart && !atEnd) event.stopPropagation();
          }
        }}
        className="w-field! px-2!"
      />
      <Menu
        label={t('minibar.fontSize')}
        side="bottom"
        align="start"
        disabled={disabled}
        entries={MINI_FONT_SIZES.map((size) => ({
          id: String(size),
          label: t('minibar.fontSizeValue', { n: size }),
          checked: value.value === size,
          onSelect: () => onChange(size),
        }))}
        trigger={(trigger) => (
          <IconButton
            {...trigger}
            {...ITEM}
            label={t('minibar.options', { name: t('minibar.fontSize') })}
            icon={ChevronDown}
            iconSize={16}
            disabled={disabled}
            focusableWhenDisabled
            className="size-8! w-6!"
          />
        )}
      />
    </div>
  );
}

const LinePreview = ({ points }: { points: number }) => (
  <svg viewBox="0 0 24 8" aria-hidden="true" focusable="false" className="w-6 shrink-0">
    <line x1="2" x2="22" y1="4" y2="4" stroke="currentColor" strokeWidth={points} strokeLinecap="round" />
  </svg>
);

export function StrokeControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<number>; onChange: (pt: number) => void }) {
  const t = useT();
  return (
    <Dropdown
      label={t('minibar.stroke')}
      disabled={disabled}
      entries={MINI_STROKES.map((points) => ({
        id: String(points),
        label: t('minibar.strokeValue', { n: points }),
        leading: <LinePreview points={points} />,
        checked: value.value === points,
        onSelect: () => onChange(points),
      }))}
    >
      {value.value === null ? MIXED : <LinePreview points={value.value} />}
    </Dropdown>
  );
}

/** The heads of an arrow (DESIGN 3.5 B11): "End" (one head at the end) or "Both". */
export function EndsControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<ArrowEnds>; onChange: (ends: ArrowEnds) => void }) {
  const t = useT();
  const choices: readonly { id: ArrowEnds; label: string }[] = [
    { id: 'end', label: t('shape.arrowEnd') },
    { id: 'both', label: t('shape.arrowBoth') },
  ];
  const shown = choices.find((choice) => choice.id === value.value);
  return (
    <Dropdown
      label={t('shape.arrowEnds')}
      disabled={disabled}
      entries={choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        checked: value.value === choice.id,
        radio: true,
        onSelect: () => onChange(choice.id),
      }))}
    >
      {shown === undefined ? MIXED : shown.label}
    </Dropdown>
  );
}

export function OpacityControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<number>; onChange: (ratio: number) => void }) {
  const t = useT();
  const percent = value.value === null ? null : Math.round(value.value * 100);
  return (
    <Dropdown
      label={t('minibar.opacity')}
      disabled={disabled}
      entries={MINI_OPACITIES.map((n) => ({
        id: String(n),
        label: t('minibar.opacityValue', { n }),
        checked: percent === n,
        onSelect: () => onChange(n / 100),
      }))}
    >
      {percent === null ? MIXED : t('minibar.opacityValue', { n: percent })}
    </Dropdown>
  );
}

/** The fill of a rectangle or ellipse: "None" and the highlight swatches. */
export function FillControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<Rgb | null>; onChange: (fill: Rgb | null) => void }) {
  const t = useT();
  const current = value.value;
  const entries = [
    {
      id: 'none',
      label: t('minibar.fillNone'),
      checked: !value.mixed && current === null,
      onSelect: () => onChange(null),
    },
    ...HIGHLIGHT_PALETTE.map((entry) => ({
      id: entry.id,
      label: t(entry.nameKey),
      leading: (
        <span aria-hidden="true" className={cx('block size-4 rounded-pill border border-control-border', entry.bg)} />
      ),
      checked: current !== null && sameRgb(current, entry.rgb),
      onSelect: () => onChange(entry.rgb),
    })),
  ];
  const entry = current === null ? undefined : HIGHLIGHT_PALETTE.find((e) => sameRgb(e.rgb, current));
  return (
    <Dropdown label={t('minibar.fill')} disabled={disabled} entries={entries}>
      {value.mixed ? (
        MIXED
      ) : current === null ? (
        t('minibar.fillNone')
      ) : (
        <span
          aria-hidden="true"
          className={cx('block size-4 rounded-pill border border-control-border', entry?.bg)}
          style={entry === undefined ? { backgroundColor: rgbToCss(current) } : undefined}
        />
      )}
    </Dropdown>
  );
}

export const ALIGN_KINDS: readonly KindOption[] = [
  { value: 'left', icon: AlignLeft, labelKey: 'align.left' },
  { value: 'center', icon: AlignCenter, labelKey: 'align.center' },
  { value: 'right', icon: AlignRight, labelKey: 'align.right' },
];

/** The alignment of a text comment's lines (DESIGN 3.5 B4): three icons, `/Q` in the file. */
export function AlignControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<TextAlign>; onChange: (align: TextAlign) => void }) {
  const t = useT();
  return (
    <KindControl
      label={t('minibar.align')}
      options={ALIGN_KINDS}
      value={value}
      disabled={disabled}
      onChange={(align) => onChange(align as TextAlign)}
    />
  );
}

/**
 * A toggle with a menu beside it (DESIGN 3.5 B4): the button switches the feature on and off (\`aria-pressed\`), the chevron opens its
 * options. Both are stops of the bar's roving focus.
 */
function SplitToggle({
  icon,
  label,
  menuLabel,
  pressed,
  mixed,
  disabled,
  onToggle,
  children,
}: DisabledProps & {
  icon: LucideIcon;
  label: string;
  menuLabel: string;
  pressed: boolean;
  mixed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center">
      <IconButton
        {...ITEM}
        icon={icon}
        label={label}
        variant="toggle"
        pressed={pressed}
        disabled={disabled}
        focusableWhenDisabled
        onClick={onToggle}
        className={cx(SQUARE, mixed && 'opacity-60')}
      />
      <Popover
        label={menuLabel}
        disabled={disabled}
        trigger={(trigger) => (
          <IconButton
            {...trigger}
            {...ITEM}
            label={menuLabel}
            icon={ChevronDown}
            iconSize={16}
            disabled={disabled}
            focusableWhenDisabled
            className="size-8! w-6!"
          />
        )}
      >
        <div className="flex flex-col gap-3">{children}</div>
      </Popover>
    </div>
  );
}

/** What the border control shows and sets: the width in points (0 is off) and the colour. */
export interface BorderValue {
  width: Shared<number>;
  colour: Shared<Rgb>;
}

/** The border of a text comment: on/off, and in the menu its colour (B5) and width 0.5, 1 or 2 pt. */
export function BorderControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: BorderValue; onChange: (change: { borderWidth?: number; borderColor?: Rgb }) => void }) {
  const t = useT();
  const last = useTools((state) => state.defaults.freeText);
  const width = value.width.value;
  const on = width !== null && width > 0;
  const lastWidth = last?.borderWidth ?? FIRST_BORDER_PT;
  const lastColour = last?.borderColor ?? FIRST_BORDER_COLOUR;
  // A choice in the menu also switches the border on, at the last width.
  const wake = on ? {} : { borderWidth: lastWidth };
  return (
    <SplitToggle
      icon={Square}
      label={t('textComment.border')}
      menuLabel={t('minibar.options', { name: t('textComment.border') })}
      pressed={on}
      mixed={value.width.mixed}
      disabled={disabled}
      onToggle={() =>
        onChange(on ? { borderWidth: 0 } : { borderWidth: lastWidth, borderColor: value.colour.value ?? lastColour })
      }
    >
      <div role="group" aria-label={t('minibar.borderColour')} className="flex flex-wrap items-center">
        <ColourRow
          palette="stroke"
          roving={false}
          disabled={disabled}
          value={
            value.colour.value === null ? { value: null, mixed: true } : { value: value.colour.value, mixed: false }
          }
          onChange={(borderColor) => onChange({ borderColor, ...wake })}
        />
      </div>
      <Segmented
        label={t('minibar.borderWidth')}
        value={on ? String(width) : ''}
        disabled={disabled}
        options={BORDER_WIDTHS.map((n) => ({ value: String(n), label: t('minibar.strokeValue', { n }) }))}
        onValueChange={(next) => onChange({ borderWidth: Number(next) })}
      />
    </SplitToggle>
  );
}

/** The fill of a text comment: on/off (opaque), and in the menu its colour from the highlight palette and B5. */
export function TextFillControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<Rgb | null>; onChange: (fill: Rgb | null) => void }) {
  const t = useT();
  const last = useTools((state) => state.defaults.freeText);
  const colour = value.value;
  const on = colour !== null;
  return (
    <SplitToggle
      icon={PaintBucket}
      label={t('textComment.fill')}
      menuLabel={t('minibar.options', { name: t('textComment.fill') })}
      pressed={on}
      mixed={value.mixed}
      disabled={disabled}
      onToggle={() => onChange(on ? null : (last?.fillColor ?? FIRST_FILL_COLOUR))}
    >
      <div role="group" aria-label={t('minibar.fillColour')} className="flex flex-wrap items-center">
        <ColourRow
          palette="highlight"
          roving={false}
          disabled={disabled}
          value={colour === null ? { value: null, mixed: value.mixed } : { value: colour, mixed: false }}
          onChange={(rgb) => onChange(rgb)}
        />
      </div>
    </SplitToggle>
  );
}
