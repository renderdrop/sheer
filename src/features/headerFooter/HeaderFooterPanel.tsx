import { ChevronDown, PanelTop } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ComponentProps } from 'react';

import { detectHeaderFooter, type DetectedItem, type HfSlot } from '../../api/headerFooter';
import { Button, Checkbox, Field, Icon, Menu, Segmented, type MenuItemSpec } from '../../components';
import { cx } from '../../components/cx';
import { useLocale, useT } from '../../i18n';
import { useSlots } from '../../stores/pages';
import { InspectorFrame, InspectorSection, InspectorSections, type InspectorFooter } from '../inspector/InspectorFrame';
import {
  FONT_SIZES,
  HF_ROWS,
  MARGINS,
  PAGE_FORMATS,
  SLOT_KINDS,
  TEXT_MAX,
  buildSpec,
  canApply,
  columnOf,
  defaultDraft,
  draftFromSpec,
  formatHfDate,
  rangeOf,
  rowOf,
  withRange,
  withValue,
  type Draft,
  type PageFormat,
  type SlotKind,
} from './model';
import { Preview } from './Preview';
import { closeHeaderFooterDialog, commitHeaderFooter } from './runtime';
import { useHeaderFooter, type HfDialogState } from './store';

/** A dropdown trigger (DESIGN 3.15 HF2): 32 high, padding-x 8; the current place has a 1 px Ink border. */
function Trigger({ current, ...rest }: { current?: boolean } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        't-body flex min-h-control-md w-full min-w-0 cursor-pointer items-center justify-between gap-1 rounded-button border bg-surface px-2 py-1 text-text',
        'hover:border-b-text transition-colors [transition-duration:var(--motion-fast)]',
        current === true ? 'border-text' : 'border-border-subtle border-b-control-border',
        rest.className,
      )}
    >
      {rest.children}
    </button>
  );
}

function Panel({ request }: { request: HfDialogState }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const { docId, info } = request;
  const total = useSlots(docId).length;
  const busy = useHeaderFooter((state) => state.busy[docId] === true);
  const [initial] = useState<Draft>(() => {
    if (request.draft !== undefined) return request.draft;
    const base = info.spec !== null ? draftFromSpec(info.spec, total) : defaultDraft();
    return request.preselect !== null && info.spec === null
      ? withRange(base, Math.min(request.preselect.first, total), Math.min(request.preselect.last, total))
      : base;
  });
  const [draft, setDraft] = useState<Draft>(initial);
  // A fresh file has nothing to compare with: the default draft counts as unchanged only when a spec is there to reproduce.
  // Which slot is being edited (`current`) is no change of the headers.
  const changed = JSON.stringify({ ...draft, current: initial.current }) !== JSON.stringify(initial);
  const patch = (next: Partial<Draft>) => setDraft((old) => ({ ...old, ...next }));
  const patchSlot = (slot: HfSlot, next: Partial<Draft['slots'][HfSlot]>) =>
    setDraft((old) => ({ ...old, slots: { ...old.slots, [slot]: { ...old.slots[slot], ...next } } }));

  // What the pages already have in their margin bands (a hint: a failed look is no error), and which of it the new text lands on.
  const [detected, setDetected] = useState<DetectedItem[]>([]);
  const [overlapping, setOverlapping] = useState<DetectedItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    detectHeaderFooter(docId)
      .then((found) => {
        if (!cancelled) setDetected(found.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [docId]);
  const where = (item: DetectedItem) =>
    t('hf.slotOptions', {
      row: t(`hf.${item.edge}`),
      column: t(`hf.${item.slot === 'center' ? 'centre' : item.slot}`),
    });
  const describe = (items: readonly DetectedItem[]) =>
    items
      .slice(0, 4)
      .map((item) => t('hf.detectedItem', { where: where(item), text: item.text }))
      .join('; ') + (items.length > 4 ? ' …' : '');

  const range = rangeOf(draft, total);
  const applicable = canApply(draft, total);
  const dateText = useMemo(() => formatHfDate(new Date(), locale), [locale]);
  const spec = useMemo(
    () =>
      canApply(draft, total)
        ? buildSpec(draft, { color: info.defaults.color, date: dateText, total, lang: locale })
        : null,
    [draft, total, info.defaults.color, dateText, locale],
  );
  const previewPage = range.valid && range.first !== null ? range.first : 1;

  const label = (slot: HfSlot) =>
    t('hf.slotOptions', { row: t(`hf.${rowOf(slot)}`), column: t(`hf.${columnOf(slot)}`) });
  const kindLabel = (kind: SlotKind) => t(`hf.kind.${kind}`);
  const formatLabel = (format: PageFormat) => t(`hf.page.${format}`, { n: 3, total: 12 });

  const finish = async (next: ReturnType<typeof buildSpec>, pages: number) => {
    if (await commitHeaderFooter(docId, next, pages)) closeHeaderFooterDialog();
  };
  const apply = () => {
    if (!applicable || busy || spec === null) return;
    void finish(spec, range.count);
  };

  const current = draft.slots[draft.current];
  const entriesFor = (slot: HfSlot): MenuItemSpec[] =>
    SLOT_KINDS.map((kind) => ({
      id: kind,
      label: kindLabel(kind),
      checked: draft.slots[slot].kind === kind,
      radio: true,
      onSelect: () => patchSlot(slot, { kind }),
    }));

  const trigger = (slot: HfSlot) => {
    const slotDraft = draft.slots[slot];
    const shown = kindLabel(slotDraft.kind);
    return (
      <Menu
        key={slot}
        label={label(slot)}
        side="bottom"
        align="start"
        entries={() => entriesFor(slot)}
        trigger={(props) => (
          <Trigger
            {...props}
            aria-label={label(slot)}
            aria-current={draft.current === slot ? 'true' : undefined}
            current={draft.current === slot}
            data-hf-slot={slot}
            onFocus={() => patch({ current: slot })}
          >
            <span className="flex min-w-0 flex-col items-start text-start" data-hf-slot-text="">
              <span className="t-caption text-text-muted">{t(`hf.${columnOf(slot)}`)}</span>
              <span className="min-w-0 break-words">{shown}</span>
            </span>
            <Icon icon={ChevronDown} className="shrink-0" />
          </Trigger>
        )}
      />
    );
  };

  const optionsId = `${id}-options`;
  const options = (() => {
    switch (current.kind) {
      case 'text':
        return (
          <Field
            aria-labelledby={optionsId}
            value={current.text}
            maxLength={TEXT_MAX}
            data-hf="text"
            className="w-full"
            onChange={(event) => patchSlot(draft.current, { text: event.target.value })}
          />
        );
      case 'page':
        return (
          <Menu
            label={t('hf.kind.page')}
            side="bottom"
            align="start"
            entries={() =>
              PAGE_FORMATS.map((format): MenuItemSpec => ({
                id: format,
                label: formatLabel(format),
                checked: current.format === format,
                radio: true,
                onSelect: () => patchSlot(draft.current, { format }),
              }))
            }
            trigger={(props) => (
              <Trigger {...props} aria-labelledby={`${optionsId} ${optionsId}-value`} data-hf="page-format">
                <span id={`${optionsId}-value`} className="min-w-0 truncate">
                  {formatLabel(current.format)}
                </span>
                <Icon icon={ChevronDown} />
              </Trigger>
            )}
          />
        );
      case 'date':
        return (
          <p className="t-caption m-0 text-text-muted" data-hf="date-sample">
            {dateText}
          </p>
        );
      case 'file':
      case 'none':
        return null;
    }
  })();

  const footer: InspectorFooter = {
    // A file without headers or footers can take the default as it is; one that has them needs a change.
    apply: {
      label: t('inspector.apply'),
      disabled: !applicable || !(changed || info.spec === null),
      busy,
      onApply: apply,
    },
    reset: { disabled: !changed, onReset: () => setDraft({ ...initial, current: draft.current }) },
  };

  return (
    <InspectorFrame
      icon={PanelTop}
      title={t('hf.title')}
      surface="hf-dialog"
      footer={footer}
      onDismiss={closeHeaderFooterDialog}
    >
      <InspectorSections>
        <InspectorSection>
          <div className="flex flex-col gap-2" data-hf="slots">
            {HF_ROWS.map((row) => (
              <div key={row.id} role="group" aria-label={t(`hf.${row.id}`)} className="flex flex-col gap-1">
                <span className="t-caption text-text-muted">{t(`hf.${row.id}`)}</span>
                <div className="grid grid-cols-3 gap-2">{row.slots.map(trigger)}</div>
              </div>
            ))}
          </div>
          <div className="flex min-h-(--hf-options-h) flex-col gap-1" data-hf="options">
            <span id={optionsId} className="t-caption text-text-muted">
              {label(draft.current)}
            </span>
            {options}
          </div>
        </InspectorSection>
        <InspectorSection>
          <div className="flex flex-col gap-1">
            <span className="t-caption text-text-muted">{t('hf.size')}</span>
            <Segmented
              label={t('hf.size')}
              value={String(draft.fontSize)}
              options={withValue(FONT_SIZES, draft.fontSize).map((n) => ({
                value: String(n),
                label: t('hf.pt', { n }),
              }))}
              onValueChange={(value) => patch({ fontSize: Number(value) })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="t-caption text-text-muted">{t('hf.margin')}</span>
            <Segmented
              label={t('hf.margin')}
              value={String(draft.margin)}
              options={withValue(MARGINS, draft.margin).map((n) => ({ value: String(n), label: t('hf.pt', { n }) }))}
              onValueChange={(value) => patch({ margin: Number(value) })}
            />
          </div>
          <label className="t-body flex cursor-pointer items-center gap-2" data-hf="background">
            <Checkbox
              checked={draft.background}
              data-hf="background-toggle"
              onChange={(event) => patch({ background: event.target.checked })}
            />
            {t('hf.background')}
          </label>
          {detected.length > 0 && (
            <div className="flex flex-col gap-1" data-hf="detected">
              <p
                className="t-caption m-0 truncate text-text-muted"
                title={t('hf.detected', { items: describe(detected) })}
              >
                {t('hf.detected', { items: describe(detected) })}
              </p>
              {overlapping.length > 0 && (
                <p
                  role={draft.background ? undefined : 'alert'}
                  className={cx('t-caption m-0', draft.background ? 'text-text-muted' : 'text-error-text')}
                  data-hf={draft.background ? 'covers' : 'overlap'}
                >
                  {t(draft.background ? 'hf.covered' : 'hf.overlap', { items: describe(overlapping) })}
                </p>
              )}
            </div>
          )}
        </InspectorSection>
        <InspectorSection caption={t('hf.range.some')}>
          <div className="flex flex-col gap-2" data-hf="pages">
            <Segmented
              label={t('hf.range.some')}
              value={draft.allPages ? 'all' : 'some'}
              options={[
                { value: 'all', label: t('hf.range.all') },
                { value: 'some', label: t('hf.range.some') },
              ]}
              onValueChange={(value) => patch({ allPages: value === 'all' })}
            />
            {!draft.allPages && (
              <div className="grid grid-cols-2 gap-2 tabular-nums">
                {(['from', 'to'] as const).map((key) => (
                  <label key={key} className="flex min-w-0 flex-col gap-1">
                    <span className="t-caption text-text-muted">{t(`hf.range.${key}`)}</span>
                    <Field
                      inputMode="numeric"
                      value={draft[key]}
                      placeholder={key === 'from' ? '1' : String(total)}
                      aria-invalid={range.valid ? undefined : true}
                      aria-describedby={range.valid ? undefined : `${id}-range-error`}
                      data-hf={`range-${key}`}
                      className="w-full"
                      onChange={(event) => patch({ [key]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
            )}
            {!range.valid && (
              <p
                id={`${id}-range-error`}
                role="alert"
                className="t-caption m-0 text-error-text"
                data-hf="range-invalid"
              >
                {t('hf.range.invalid', { total })}
              </p>
            )}
          </div>
        </InspectorSection>
        <div className="flex w-full flex-col items-center gap-1">
          <Preview docId={docId} pageNumber={previewPage} spec={spec} detected={detected} onOverlap={setOverlapping} />
          <span className="t-caption text-text-muted" aria-hidden="true">
            {t('hf.previewPage', { n: previewPage })}
          </span>
        </div>
        {(info.fileLayers > 0 || info.spec !== null) && (
          <Button
            variant="ghost"
            data-hf="remove"
            className="self-start"
            disabled={busy}
            focusableWhenDisabled
            onClick={() => void finish(null, 0)}
          >
            {t('hf.remove')}
          </Button>
        )}
      </InspectorSections>
    </InspectorFrame>
  );
}

/** The headers and footers form (DESIGN §3.18 E5), open while `useHeaderFooter.dialog` is set. */
export function HeaderFooterPanel() {
  const request = useHeaderFooter((state) => state.dialog);
  return request === null ? null : <Panel key={request.docId} request={request} />;
}
