import {
  Check,
  ChevronDown,
  Circle,
  Highlighter,
  MessageSquare,
  Strikethrough,
  Trash2,
  Underline,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { Rgb } from '../../api/annotations';
import { Icon, IconButton, Menu, Swatch, Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { useT, type PlainKey } from '../../i18n';
import { HIGHLIGHT_PALETTE, isCustomColour, PALETTES, rgbToCss, sameRgb, type PaletteName } from '../inspector/palette';
import type { Shared } from '../inspector/properties';
import { MINI_FONT_SIZES, MINI_OPACITIES, MINI_STROKES } from './model';

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

/** Swatches of one palette plus "Custom" for a colour that is in none of it; with a mixed selection none is checked (an empty ring). */
export function ColourControl({
  palette,
  value,
  disabled,
  onChange,
}: DisabledProps & { palette: PaletteName; value: Shared<Rgb>; onChange: (rgb: Rgb) => void }) {
  const t = useT();
  const custom = value.value !== null && isCustomColour(value.value, palette) ? value.value : null;
  const pick = (rgb: Rgb) => {
    if (!disabled) onChange(rgb);
  };
  return (
    <div role="group" aria-label={t('minibar.colour')} className="flex items-center">
      {PALETTES[palette].map((entry) => (
        <Tooltip key={entry.id} label={t(entry.nameKey)}>
          <Swatch
            {...ITEM}
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
      {custom !== null && (
        <Tooltip label={t('colour.custom')}>
          <Swatch
            {...ITEM}
            label={t('colour.custom')}
            checked
            // A colour of the file is data, not a design colour: it can only be set inline.
            style={{ backgroundColor: rgbToCss(custom) }}
            checkClass={luminance(custom) > 0.4 ? 'text-ink' : 'text-page'}
            aria-disabled={disabled ? true : undefined}
            onClick={() => pick(custom)}
            className="mx-1 before:absolute before:-inset-1 before:content-['']"
          />
        </Tooltip>
      )}
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

export function FontSizeControl({
  value,
  disabled,
  onChange,
}: DisabledProps & { value: Shared<number>; onChange: (pt: number) => void }) {
  const t = useT();
  return (
    <Dropdown
      label={t('minibar.fontSize')}
      disabled={disabled}
      className="w-field!"
      entries={MINI_FONT_SIZES.map((size) => ({
        id: String(size),
        label: t('minibar.fontSizeValue', { n: size }),
        checked: value.value === size,
        onSelect: () => onChange(size),
      }))}
    >
      {value.value === null ? MIXED : t('minibar.fontSizeValue', { n: value.value })}
    </Dropdown>
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
