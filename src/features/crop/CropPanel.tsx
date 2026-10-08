import { Crop } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { PageCrop } from '../../api/pages';
import { Field } from '../../components';
import { useLocale, useT, type PlainKey } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { InspectorFrame, InspectorSection, InspectorSections, type InspectorFooter } from '../inspector/InspectorFrame';
import { RadioGroup } from '../jobs/RadioGroup';
import { applyCrop, cancelCrop, fitsAll, targetPages } from './actions';
import { isValid, pageSideOf, type Side } from './geometry';
import { currentMargins, keyOf, useCrop, useCropTarget, type CropTarget, type Scope } from './store';
import { STEP, formatMargin, parseMargin, ptToUnit, unitFor, unitToPt, type Unit } from './units';

/** The margins in the order of the form (DESIGN §3.18 E5): Top, Bottom / Left, Right, the sides as they are on screen. */
const GRID: readonly { side: Side; label: PlainKey }[] = [
  { side: 'top', label: 'crop.top' },
  { side: 'bottom', label: 'crop.bottom' },
  { side: 'left', label: 'crop.left' },
  { side: 'right', label: 'crop.right' },
];

interface MarginFieldProps {
  target: CropTarget;
  /** The side on screen; the margin it edits is the page's side under the rotation. */
  viewSide: Side;
  label: string;
  unit: Unit;
  onValidity: (side: Side, valid: boolean) => void;
}

function MarginField({ target, viewSide, label, unit, onValidity }: MarginFieldProps) {
  const locale = useLocale();
  const id = useId();
  const side = pageSideOf(viewSide, target.total);
  const value = target.margins[side];
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const key = keyOf(target.docId, target.slot.id);

  // A change of the rectangle (a drag, an arrow key, another field) makes a typed value and its error stale.
  const [seen, setSeen] = useState(target.margins);
  if (seen !== target.margins) {
    setSeen(target.margins);
    setInvalid(false);
    setDraft(null);
  }

  /** Moves the rectangle to the typed value when it leaves a valid rectangle; says so otherwise. */
  const commit = (pt: number | null): boolean => {
    const next: PageCrop = { ...target.margins, [side]: pt ?? Number.NaN };
    const ok = pt !== null && isValid(next, target.frame);
    setInvalid(!ok);
    onValidity(viewSide, ok);
    if (ok) {
      useCrop.getState().setMargins(key, next);
      setDraft(null);
    }
    return ok;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // A typed value is taken first; Enter on a field without one reaches the frame and applies (DESIGN §3.18 E5).
      if (draft === null) return;
      event.preventDefault();
      event.stopPropagation();
      commit(parseMargin(draft, unit));
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = draft === null ? value : (parseMargin(draft, unit) ?? value);
    const step = STEP[unit] * (event.shiftKey ? 10 : 1);
    // Up grows the margin, as in a number field.
    const next = ptToUnit(current, unit) + (event.key === 'ArrowUp' ? step : -step);
    commit(unitToPt(Math.max(0, Math.round(next * 1000) / 1000), unit));
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="t-caption text-text-muted">
        {label}
      </label>
      <Field
        tight
        align="end"
        id={id}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid ? true : undefined}
        value={draft ?? formatMargin(value, unit, locale)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) commit(parseMargin(draft, unit));
        }}
        onKeyDown={onKeyDown}
        className="w-full min-w-0 tabular-nums"
      />
    </div>
  );
}

const sameMargins = (a: PageCrop, b: PageCrop): boolean =>
  a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

/**
 * The crop inspector (DESIGN §3.18 E5): margins in the unit of the locale, the pages they reach, Reset and Apply. The handles on
 * the canvas edit the same rectangle in the crop store, so fields and handles stay in step. Esc or Close ends the tool; nothing was sent.
 */
export function CropPanel() {
  const t = useT();
  const locale = useLocale();
  const target = useCropTarget();
  const scope = useCrop((state) => state.scope);
  const range = useCrop((state) => state.range);
  const readOnly = useDocuments((state) =>
    target === null
      ? false
      : state.byId[target.docId]?.kind === 'welcome' || state.byId[target.docId]?.signatureLock === 'locked',
  );
  const [badSides, setBadSides] = useState<ReadonlySet<Side>>(new Set());
  const rangeId = useId();
  const errorId = useId();
  const margins = target?.margins;
  const [seenMargins, setSeenMargins] = useState(margins);
  if (seenMargins !== margins) {
    setSeenMargins(margins);
    if (badSides.size > 0) setBadSides(new Set());
  }
  if (target === null) return null;

  const unit = unitFor(locale);
  const pages = targetPages(target.slots, target.slot, scope, range);
  const rangeInvalid = scope === 'range' && pages === null;
  const fits = pages !== null && fitsAll(target.margins, pages);
  const tooSmall = badSides.size > 0 || (pages !== null && !fits);
  // Changed: the rectangle left the page's own crop, or the crop is meant for more than this page.
  const differs = !sameMargins(target.margins, currentMargins(target.slot)) || scope !== 'current';
  const canApply = pages !== null && fits && !readOnly && badSides.size === 0 && differs;

  const onValidity = (side: Side, valid: boolean) =>
    setBadSides((previous) => {
      if (previous.has(side) !== valid) return previous;
      const next = new Set(previous);
      if (valid) next.delete(side);
      else next.add(side);
      return next;
    });

  const options: { value: Scope; label: string; content: ReactNode }[] = (
    [
      ['current', 'crop.pages.this'],
      ['all', 'crop.pages.all'],
      ['range', 'crop.pages.range'],
    ] as const
  ).map(([value, key]) => ({ value, label: t(key), content: t(key) }));

  const footer: InspectorFooter = {
    apply: {
      label: t('inspector.apply'),
      disabled: !canApply,
      onApply: () => void applyCrop(target.docId, target.slot, target.margins),
    },
    reset: {
      disabled: readOnly || (!differs && range === ''),
      onReset: () => useCrop.getState().clear(),
    },
  };

  return (
    <InspectorFrame icon={Crop} title={t('crop.title')} surface="crop" footer={footer} onDismiss={cancelCrop}>
      <InspectorSections>
        <InspectorSection caption={t('crop.margins', { unit })}>
          <div key={target.slot.id} data-crop-fields="" className="grid grid-cols-2 gap-2">
            {GRID.map(({ side, label }) => (
              <MarginField
                key={side}
                target={target}
                viewSide={side}
                label={t(label)}
                unit={unit}
                onValidity={onValidity}
              />
            ))}
          </div>
          <div className="text-sm text-error-text" role="status">
            {tooSmall && <p className="m-0">{t('crop.tooSmall')}</p>}
          </div>
        </InspectorSection>
        <InspectorSection caption={t('crop.pages')}>
          <RadioGroup
            label={t('crop.pages')}
            value={scope}
            options={options}
            onChange={(next) => useCrop.getState().setScope(next)}
            orientation="horizontal"
            look="segmented"
            className="flex w-full"
          />
          {scope === 'range' && (
            <div className="flex flex-col gap-1">
              <Field
                id={rangeId}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('crop.range')}
                aria-invalid={rangeInvalid && range.trim() !== '' ? true : undefined}
                aria-describedby={rangeInvalid ? errorId : undefined}
                placeholder={t('crop.rangePlaceholder')}
                value={range}
                onChange={(event) => useCrop.getState().setRange(event.target.value)}
                className="w-full"
              />
              {rangeInvalid && range.trim() !== '' && (
                <p id={errorId} className="m-0 text-sm text-error-text">
                  {t('split.invalid', { n: target.slots.length })}
                </p>
              )}
            </div>
          )}
        </InspectorSection>
      </InspectorSections>
    </InspectorFrame>
  );
}
