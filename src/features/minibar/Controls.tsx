import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  ChevronDown,
  Circle,
  Highlighter,
  Copy,
  MessageSquare,
  PaintBucket,
  Quote,
  Square,
  Strikethrough,
  Trash2,
  Underline,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import type { Rgb, StampTone, TextAlign } from '../../api/annotations';
import {
  Button,
  ColourPopover,
  Field,
  Icon,
  IconButton,
  Menu,
  Popover,
  RECENT_IN_ROW,
  Segmented,
  Swatch,
  Toggle,
  Tooltip,
  toHex,
  type ColourEntry,
} from '../../components';
import { cx } from '../../components/cx';
import { formatNumber, useLocale, useT, type PlainKey } from '../../i18n';
import { useRecentColours } from '../../stores/recentColours';
import { useTools } from '../../stores/tools';
import { StampPickerBody } from '../annotations/stamps/StampPicker';
import { useStamp } from '../annotations/stamps/store';
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
  fixed = false,
}: DisabledProps & {
  palette: PaletteName;
  value: Shared<Rgb>;
  onChange: (rgb: Rgb) => void;
  roving?: boolean;
  /** Only the palette's own swatches: no custom or recent colour beside them (the citation row, DESIGN 3.7 C4). */
  fixed?: boolean;
}) {
  const t = useT();
  const recent = useRecentColours((state) => state.colours);
  const item = roving ? ITEM : {};
  const custom = value.value !== null && isCustomColour(value.value, palette) ? value.value : null;
  const pick = (rgb: Rgb) => {
    if (!disabled) onChange(rgb);
  };
  const customs: Rgb[] = fixed
    ? []
    : [
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
  props: DisabledProps & { palette: PaletteName; value: Shared<Rgb>; onChange: (rgb: Rgb) => void; fixed?: boolean },
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
                  ? 'border-control-border bg-surface text-text'
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

/** A stamp's colour (DESIGN 3.14 ST5): Solar or Ink, two swatches. A radio group like the other colour rows. */
export function StampToneControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<StampTone>; onChange: (tone: StampTone) => void }) {
  const t = useT();
  const tones: readonly { tone: StampTone; label: string; fill: string; check: string }[] = [
    { tone: 'solar', label: t('stamp.colour.solar'), fill: 'bg-hl-solar', check: 'text-ink' },
    { tone: 'ink', label: t('stamp.colour.ink'), fill: 'bg-stroke-ink', check: 'text-page' },
  ];
  return (
    <div role="radiogroup" aria-label={t('minibar.colour')} className="flex items-center">
      {tones.map((entry) => (
        <Tooltip key={entry.tone} label={entry.label}>
          <Swatch
            {...ITEM}
            label={entry.label}
            checked={value.value === entry.tone}
            fillClass={entry.fill}
            checkClass={entry.check}
            aria-disabled={disabled ? true : undefined}
            onClick={() => {
              if (!disabled) onChange(entry.tone);
            }}
            className="mx-1 before:absolute before:-inset-1 before:content-['']"
          />
        </Tooltip>
      ))}
    </div>
  );
}

/** "Change…" (DESIGN 3.14 ST5): opens the stamp picker anchored to the bar; a choice replaces the text, keeping centre and height. */
export function StampChangeControl({ id, tone, disabled }: DisabledProps & { id: number; tone: StampTone }) {
  const t = useT();
  const open = useStamp((state) => state.pickerOpen && state.changing === id);
  return (
    <Popover
      label={t('stamp.change')}
      open={open}
      disabled={disabled === true}
      onOpenChange={(next) => {
        const stamp = useStamp.getState();
        if (next) {
          stamp.choose({ tone });
          stamp.setChanging(id);
        }
        stamp.setPicker(next);
      }}
      trigger={(props) => (
        <Button {...props} {...ITEM} variant="ghost" disabled={disabled === true} focusableWhenDisabled>
          {t('stamp.change')}
        </Button>
      )}
    >
      {({ close }) => <StampPickerBody close={close} />}
    </Popover>
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

/** "Open citation" (DESIGN 3.7 C4): focuses the citation's bubble in the margin. */
export function OpenCitationControl({ label, onOpen }: { label: string; onOpen: () => void }) {
  return <IconButton {...ITEM} icon={Quote} label={label} onClick={onOpen} className={SQUARE} />;
}

/** "Copy citation" (DESIGN 3.7 C4): the quote and its short citation go to the clipboard. */
export function CopyCitationControl({ label, onCopy }: { label: string; onCopy: () => void }) {
  return <IconButton {...ITEM} icon={Copy} label={label} onClick={onCopy} className={SQUARE} />;
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

/**
 * The line width (DESIGN 3.9 Q3): a segmented control, track 32 high, five segments of a fixed 36 width (numbers only, locale decimal,
 * tabular, never wrapping), and the unit once after it. A width a file has that is none of the five selects no segment; the tooltip
 * names it. The segments are stops of the bar's roving focus.
 */
export function StrokeControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<number>; onChange: (pt: number) => void }) {
  const t = useT();
  const locale = useLocale();
  const current = value.value;
  const custom = current !== null && !MINI_STROKES.some((points) => points === current);
  const track = (
    <div role="radiogroup" aria-label={t('minibar.stroke')} className="inline-flex h-8 rounded-md bg-subtle p-half">
      {MINI_STROKES.map((points) => {
        const checked = current === points;
        return (
          <button
            key={points}
            {...ITEM}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={t('mini.strokePt', { n: formatNumber(points, locale) })}
            aria-disabled={disabled ? true : undefined}
            onClick={() => {
              if (!disabled && !checked) onChange(points);
            }}
            className={cx(
              'inline-flex h-control-sm w-control-md shrink-0 cursor-pointer items-center justify-center rounded-sm border text-md whitespace-nowrap tabular-nums',
              'transition-[background-color,color,border-color] duration-fast',
              'aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)',
              checked
                ? 'border-control-border bg-surface text-text'
                : 'border-transparent text-text-muted not-aria-disabled:hover:text-text',
            )}
          >
            {formatNumber(points, locale)}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="flex shrink-0 items-center gap-1">
      {custom ? <Tooltip label={t('mini.strokePt', { n: formatNumber(current, locale) })}>{track}</Tooltip> : track}
      <span className="t-caption text-text-muted">{t('mini.strokeUnit')}</span>
    </div>
  );
}

/** "Straighten shapes automatically" (DESIGN 3.9 Q5): the switch of the drawing bar, the one stored choice of the tools store. */
export function StraightenControl({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const on = useTools((state) => state.straightenShapes);
  const set = useTools((state) => state.setStraightenShapes);
  const labelId = useId();
  // Too narrow for the label (DESIGN 3.3 / Q9 no truncation): the switch becomes an icon toggle; name and help stay in the tooltip.
  if (compact) {
    return (
      <IconButton
        {...ITEM}
        icon={WandSparkles}
        variant="toggle"
        pressed={on}
        label={t('draw.straighten')}
        hint={t('draw.straightenHelp')}
        onClick={() => set(!on)}
        className={SQUARE}
      />
    );
  }
  return (
    <Tooltip label={t('draw.straightenHelp')}>
      <div role="group" aria-labelledby={labelId} className="flex shrink-0 items-center gap-2">
        <span id={labelId} className="t-label whitespace-nowrap text-text">
          {t('draw.straighten')}
        </span>
        <Toggle {...ITEM} checked={on} onCheckedChange={set} aria-labelledby={labelId} />
      </div>
    </Tooltip>
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
    <div role="group" aria-label={label} data-split="" className="flex items-center">
      <IconButton
        {...ITEM}
        icon={icon}
        label={label}
        variant="toggle"
        pressed={pressed}
        disabled={disabled}
        focusableWhenDisabled
        onClick={onToggle}
        className={cx(SQUARE, 'rounded-none!', mixed && 'opacity-60')}
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
            className="size-8! w-6! rounded-none! border-s border-border-subtle"
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
