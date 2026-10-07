import { ChevronDown, PanelTop } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useId, useMemo, useState, type ComponentProps, type FormEvent } from 'react';

import { type HfSlot } from '../../api/headerFooter';
import { Button, Field, Icon, Menu, Segmented, type MenuItemSpec } from '../../components';
import { cx } from '../../components/cx';
import { APP_NAME } from '../../config/app';
import { useLocale, useT } from '../../i18n';
import { useSlots } from '../../stores/pages';
import { Modal, ModalHeader } from '../jobs/Modal';
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
        't-body flex h-control-md w-full min-w-0 cursor-pointer items-center justify-between gap-1 rounded-button border bg-surface px-2 text-text',
        'hover:border-b-text transition-colors [transition-duration:var(--motion-fast)]',
        current === true ? 'border-text' : 'border-border-subtle border-b-control-border',
        rest.className,
      )}
    >
      {rest.children}
    </button>
  );
}

function Dialog({ request }: { request: HfDialogState }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const { docId, info } = request;
  const total = useSlots(docId).length;
  const busy = useHeaderFooter((state) => state.busy[docId] === true);
  const [draft, setDraft] = useState<Draft>(() => {
    if (request.draft !== undefined) return request.draft;
    const base = info.spec !== null ? draftFromSpec(info.spec, total) : defaultDraft();
    return request.preselect !== null && info.spec === null
      ? withRange(base, Math.min(request.preselect.first, total), Math.min(request.preselect.last, total))
      : base;
  });
  const patch = (next: Partial<Draft>) => setDraft((old) => ({ ...old, ...next }));
  const patchSlot = (slot: HfSlot, next: Partial<Draft['slots'][HfSlot]>) =>
    setDraft((old) => ({ ...old, slots: { ...old.slots, [slot]: { ...old.slots[slot], ...next } } }));

  const range = rangeOf(draft, total);
  const applicable = canApply(draft, total);
  const existing = info.spec !== null || info.fileLayers > 0;
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
  const apply = (event?: FormEvent) => {
    event?.preventDefault();
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
            data-autofocus={slot === 'footerRight' ? '' : undefined}
            onFocus={() => patch({ current: slot })}
          >
            <span className="min-w-0 truncate">{shown}</span>
            <Icon icon={ChevronDown} />
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
        return <p className="t-caption m-0 text-text-muted">{t('hf.file.hint')}</p>;
      case 'none':
        return <p className="t-caption m-0 text-text-muted">{t('hf.none.hint')}</p>;
    }
  })();

  return (
    <Modal labelledBy={`${id}-title`} width="w-sheet-wide" onClose={closeHeaderFooterDialog}>
      <form data-surface="hf-dialog" onSubmit={apply} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <ModalHeader id={`${id}-title`} icon={<Icon icon={PanelTop} />} title={t('hf.title')} />
          {existing && (
            <p className="t-caption m-0 text-text-muted" data-hf="existing">
              {t('hf.existing', { app: APP_NAME })}
            </p>
          )}
        </div>
        <div className="flex gap-6">
          <div className="flex w-[var(--hf-column)] min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-1" data-hf="slots">
              <div className="grid grid-cols-3 gap-2" aria-hidden="true">
                {(['left', 'centre', 'right'] as const).map((column) => (
                  <span key={column} className="t-label text-text-muted">
                    {t(`hf.${column}`)}
                  </span>
                ))}
              </div>
              {HF_ROWS.map((row) => (
                <div key={row.id} role="group" aria-label={t(`hf.${row.id}`)} className="flex flex-col gap-1">
                  <span className="t-label text-text-muted">{t(`hf.${row.id}`)}</span>
                  <div className="grid grid-cols-3 gap-2">{row.slots.map(trigger)}</div>
                </div>
              ))}
            </div>
            <div className="flex h-[var(--hf-options-h)] flex-col gap-1" data-hf="options">
              <span id={optionsId} className="t-label text-text-muted">
                {label(draft.current)}
              </span>
              {options}
            </div>
            <div className="flex flex-col gap-1">
              <span className="t-label text-text-muted">{t('hf.size')}</span>
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
              <span className="t-label text-text-muted">{t('hf.margin')}</span>
              <Segmented
                label={t('hf.margin')}
                value={String(draft.margin)}
                options={withValue(MARGINS, draft.margin).map((n) => ({ value: String(n), label: t('hf.pt', { n }) }))}
                onValueChange={(value) => patch({ margin: Number(value) })}
              />
            </div>
            <div className="flex flex-col gap-1" data-hf="pages">
              <div className="flex items-center gap-2">
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
                  <div className="flex items-center gap-2 tabular-nums">
                    {(['from', 'to'] as const).map((key) => (
                      <label key={key} className="flex items-center gap-1">
                        <span className="t-label text-text-muted">{t(`hf.range.${key}`)}</span>
                        <Field
                          inputMode="numeric"
                          value={draft[key]}
                          placeholder={key === 'from' ? '1' : String(total)}
                          aria-invalid={range.valid ? undefined : true}
                          aria-describedby={range.valid ? undefined : `${id}-range-error`}
                          data-hf={`range-${key}`}
                          className="w-16"
                          onChange={(event) => patch({ [key]: event.target.value })}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
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
          </div>
          <div className="flex w-[var(--hf-preview-w)] shrink-0 flex-col items-center gap-1">
            <Preview docId={docId} pageNumber={previewPage} spec={spec} />
            <span className="t-caption text-text-muted" aria-hidden="true">
              {t('hf.previewPage', { n: previewPage })}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {info.fileLayers > 0 || info.spec !== null ? (
            <Button
              variant="ghost"
              data-hf="remove"
              disabled={busy}
              focusableWhenDisabled
              onClick={() => void finish(null, 0)}
            >
              {t('hf.remove')}
            </Button>
          ) : null}
          <div className="ms-auto flex items-center gap-2">
            <Button variant="secondary" onClick={closeHeaderFooterDialog}>
              {t('hf.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              data-hf="apply"
              aria-busy={busy || undefined}
              disabled={!applicable || busy}
              focusableWhenDisabled
            >
              {t('hf.apply')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** The headers and footers dialog (DESIGN 3.15), open while `useHeaderFooter.dialog` is set. */
export function HeaderFooterDialog() {
  const request = useHeaderFooter((state) => state.dialog);
  return <AnimatePresence>{request !== null && <Dialog key="hf" request={request} />}</AnimatePresence>;
}
