import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { PageCrop } from '../../api/pages';
import { Button, Field } from '../../components';
import { useLocale, useT, type PlainKey } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { RadioGroup } from '../jobs/RadioGroup';
import { applyCrop, cancelCrop, fitsAll, resetCrop, sizesDiffer, targetPages } from './actions';
import { isValid, pageSideOf, type Side } from './geometry';
import { keyOf, useCrop, useCropTarget, type CropTarget, type Scope } from './store';
import { STEP, formatMargin, parseMargin, ptToUnit, unitFor, unitToPt, type Unit } from './units';

/** The margins in the order of the row (DESIGN Q7): Left, Top, Right, Bottom, the sides as they are on screen. */
const GRID: readonly { side: Side; label: PlainKey }[] = [
  { side: 'left', label: 'crop.left' },
  { side: 'top', label: 'crop.top' },
  { side: 'right', label: 'crop.right' },
  { side: 'bottom', label: 'crop.bottom' },
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
      event.preventDefault();
      event.stopPropagation();
      if (draft !== null) commit(parseMargin(draft, unit));
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
      <div className="flex items-center">
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
          className="min-w-0 flex-auto tabular-nums"
        />
      </div>
    </div>
  );
}

function CropInspectorBody() {
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
  const canApply = pages !== null && fits && !readOnly;
  const canReset = !readOnly && pages !== null && pages.some((page) => page.crop !== null && page.crop !== undefined);

  const onValidity = (side: Side, valid: boolean) =>
    setBadSides((previous) => {
      if (previous.has(side) !== valid) return previous;
      const next = new Set(previous);
      if (valid) next.delete(side);
      else next.add(side);
      return next;
    });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const el = event.target instanceof HTMLElement ? event.target : null;
    if (el !== null && (el.closest('button') !== null || el.tagName === 'INPUT')) return;
    event.preventDefault();
    if (canApply) void applyCrop(target.docId, target.slot, target.margins);
  };

  const options: { value: Scope; label: string; content: ReactNode }[] = (
    [
      ['current', 'crop.pages.current'],
      ['all', 'crop.pages.all'],
      ['range', 'crop.pages.range'],
    ] as const
  ).map(([value, key]) => ({ value, label: t(key), content: t(key) }));

  return (
    <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
      <div role="group" aria-label={t('crop.margins', { unit })} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="t-label font-semibold text-text">{t('crop.margins', { unit })}</span>
          <Button
            size="sm"
            disabled={!canReset}
            focusableWhenDisabled
            onClick={() => void resetCrop(target.docId, target.slot)}
          >
            {t('crop.reset')}
          </Button>
        </div>
        <div key={target.slot.id} data-crop-fields="" className="grid grid-cols-4 gap-2">
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
        <div className="flex items-center text-sm text-error-text" role="status">
          {tooSmall && <p className="m-0">{t('crop.tooSmall')}</p>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <RadioGroup
          label={t('crop.applyTo')}
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
        {pages !== null && sizesDiffer(pages) && <p className="m-0 text-sm text-text-muted">{t('crop.sizes')}</p>}
      </div>
      <p className="m-0 text-sm text-text-muted">{t('crop.hides')}</p>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" onClick={cancelCrop}>
          {t('crop.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!canApply}
          focusableWhenDisabled
          onClick={() => void applyCrop(target.docId, target.slot, target.margins)}
        >
          {t('crop.apply')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Inspector content of the crop mode (DESIGN 3.37). Returns `null` while the mode or tool is not active, so the standard inspector shows; `useInspector`
 * (src/features/inspector/InspectorBody.tsx) asks it first.
 */
export function useCropInspector(): { title: string; body: ReactNode; footer?: ReactNode } | null {
  const t = useT();
  const active = useUi((state) => state.activeTool === 'crop');
  return active ? { title: t('crop.title'), body: <CropInspectorBody /> } : null;
}
