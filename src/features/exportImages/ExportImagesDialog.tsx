import { FileImage, Info } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  resolveExportConflicts,
  exportImages,
  type ConflictChoice,
  type ImageExportOptions,
} from '../../api/exportImages';
import type { JobEvent } from '../../api/jobs';
import { Button, Field, Icon, Slider } from '../../components';
import { formatNumber, useLocale, useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useSlots } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { JobError, Spinner } from '../jobs/JobFooter';
import { Modal, ModalHeader } from '../jobs/Modal';
import { ProgressBar } from '../jobs/ProgressBar';
import { RadioGroup } from '../jobs/RadioGroup';
import { formatSize } from '../jobs/ranges';
import { useJobRun } from '../jobs/useJobRun';
import { useOrganize } from '../organize/store';
import { marksOf, useRedact } from '../redact/store';
import {
  DPI_PRESETS,
  QUALITY_MAX,
  QUALITY_MIN,
  clampDpi,
  estimateBytes,
  loadRemembered,
  parseDpi,
  resolvePages,
  saveRemembered,
  toSelection,
  type DpiChoice,
  type Format,
  type PagesMode,
} from './model';

/** How long after the last key the range and the resolution are checked (DESIGN 3.30). */
export const VALIDATE_MS = 150;
const NONE: readonly number[] = [];
const FORMAT_NAMES: Record<Format, string> = { png: 'PNG', jpeg: 'JPEG' };

interface Conflict {
  ticket: number;
  count: number;
  names: string[];
}

const close = () => useUi.getState().setExportImagesOpen(false);

function ExportImagesModal() {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const doc = useDocuments(selectActiveDocument);
  const docId = doc?.id ?? null;
  const slots = useSlots(docId);
  const pageIndex = useView((state) => (docId === null ? 0 : (state.byDoc[docId]?.pageIndex ?? 0)));
  const selectedIds = useOrganize((state) => (docId === null ? NONE : (state.byDoc[docId]?.selected ?? NONE)));
  const hasMarks = useRedact((state) => marksOf(state, docId).length > 0);
  const permissions = doc?.flags?.permissions;
  const mayCopy = permissions === undefined || permissions === null || permissions.includes('copy');

  const [remembered] = useState(loadRemembered);
  const [format, setFormat] = useState<Format>(remembered.format);
  const [dpi, setDpi] = useState(remembered.dpi);
  const [custom, setCustom] = useState(!(DPI_PRESETS as readonly number[]).includes(remembered.dpi));
  const [dpiText, setDpiText] = useState(String(remembered.dpi));
  const [quality, setQuality] = useState(remembered.quality);
  const [mode, setMode] = useState<PagesMode>('all');
  const [rangeText, setRangeText] = useState('');
  const [settled, setSettled] = useState({ rangeText, dpiText });
  const [annotations, setAnnotations] = useState(true);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [lowered, setLowered] = useState(false);
  const single = useRef<string | null>(null);
  const run = useJobRun();
  const encoded = useRef(0);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSettled({ rangeText, dpiText }), VALIDATE_MS);
    return () => clearTimeout(timer);
  }, [rangeText, dpiText]);

  // Initial focus: Format (the chosen segment); back there when the conflict step resolves.
  const showingForm = conflict === null;
  useEffect(() => {
    if (!showingForm) return;
    body.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, [showingForm]);

  const live = settled.rangeText === rangeText && settled.dpiText === dpiText;
  const pages = useMemo(
    () => resolvePages(mode, settled.rangeText, slots, pageIndex, selectedIds),
    [mode, settled.rangeText, slots, pageIndex, selectedIds],
  );
  const customDpi = custom ? parseDpi(settled.dpiText) : dpi;
  const rangeInvalid = mode === 'range' && !pages.ok && pages.problem === 'invalid' && live;
  const dpiInvalid = custom && customDpi === null && live;
  const effectiveDpi = customDpi ?? dpi;
  const canGo = pages.ok && live && customDpi !== null && !run.running && doc !== null && mayCopy && conflict === null;

  const estimate = useMemo(() => {
    if (!pages.ok) return null;
    return { count: pages.indices.length, bytes: estimateBytes(slots, pages.indices, effectiveDpi, format, quality) };
  }, [pages, slots, effectiveDpi, format, quality]);

  const remember = (next: Partial<{ format: Format; dpi: number; quality: number }>) =>
    saveRemembered({ format, dpi, quality, ...next });

  const pickDpi = (choice: DpiChoice) => {
    if (choice === 'custom') {
      setCustom(true);
      return;
    }
    const value = Number(choice);
    setCustom(false);
    setDpi(value);
    setDpiText(String(value));
    remember({ dpi: value });
  };

  const editDpi = (text: string) => {
    setDpiText(text);
    const value = parseDpi(text);
    if (value !== null) {
      setDpi(value);
      remember({ dpi: value });
    }
  };

  const onDpiKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const base = parseDpi(dpiText) ?? dpi;
    const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
    editDpi(String(clampDpi(base + step)));
  };

  const finishWith = (event: Extract<JobEvent, { type: 'done' }>) => {
    const name = single.current;
    const message =
      event.outputs === 1 && name !== null
        ? t('exportImg.doneFile', { name })
        : t('exportImg.done', { count: event.outputs });
    useUi.getState().showToast({ message });
    // A lowered resolution is said in the dialog (info icon), which then waits for Done.
    if (event.warnings.includes('dpiLowered')) setLowered(true);
    else close();
  };

  /** Wraps the listener: counts the pages written and, when the user stopped the job, closes with the toast that says how many. */
  const watch = (onEvent: (event: JobEvent) => void) => (event: JobEvent) => {
    if (event.type === 'progress' && event.phase === 'encode') encoded.current = event.done;
    if (event.type === 'cancelled') {
      close();
      useUi.getState().showToast({ message: t('exportImg.stopped', { count: encoded.current }) });
    }
    onEvent(event);
  };

  const go = () => {
    if (!canGo || docId === null || customDpi === null) return;
    const selection = toSelection(mode, settled.rangeText, slots, pageIndex, selectedIds);
    if (selection === null) return;
    const opts: ImageExportOptions = {
      pages: selection,
      dpi: customDpi,
      format,
      jpegQuality: quality,
      annotations,
    };
    encoded.current = 0;
    const only = pages.ok && pages.indices.length === 1 ? (pages.indices[0] ?? 0) + 1 : null;
    single.current =
      only !== null && doc !== null
        ? `${doc.displayName.replace(/.pdf$/i, '')}-p${String(only).padStart(String(slots.length).length, '0')}.${format === 'png' ? 'png' : 'jpg'}`
        : null;
    run.start(async (onEvent) => {
      const start = await exportImages(docId, opts, watch(onEvent));
      if (start.type === 'started') return start.jobId;
      if (start.type === 'conflicts') setConflict({ ticket: start.ticket, count: start.count, names: start.names });
      return null;
    }, finishWith);
  };

  const resolve = (choice: ConflictChoice) => {
    if (conflict === null) return;
    const { ticket } = conflict;
    setConflict(null);
    if (choice === 'cancel') {
      resolveExportConflicts(ticket, 'cancel', () => undefined).catch(() => undefined);
      return;
    }
    encoded.current = 0;
    run.start((onEvent) => resolveExportConflicts(ticket, choice, watch(onEvent)), finishWith);
  };

  const cancel = () => {
    if (conflict !== null) resolve('cancel');
    else if (run.running) run.cancel();
    else close();
  };

  const modes: { value: PagesMode; label: string }[] = [
    { value: 'all', label: t('exportImg.all') },
    { value: 'current', label: t('exportImg.current') },
    ...(selectedIds.length > 0 ? [{ value: 'selected' as const, label: t('exportImg.selected') }] : []),
    { value: 'range', label: t('exportImg.range') },
  ];
  const dpiOptions: { value: DpiChoice; label: string }[] = [
    ...DPI_PRESETS.map((value) => ({ value: `${value}` as DpiChoice, label: formatNumber(value, locale) })),
    { value: 'custom', label: t('exportImg.custom') },
  ];
  const progress = run.progress;
  const busy = run.running;
  const rangeErrorId = `${id}-range`;
  const dpiErrorId = `${id}-dpi`;
  const labelClass = 'mb-1 text-sm font-semibold text-text-muted';

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={cancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
        className="flex flex-col"
      >
        <ModalHeader id={`${id}-title`} icon={<Icon icon={FileImage} />} title={t('exportImg.title')} />
        {lowered ? (
          <p role="status" className="m-0 mt-4 flex items-start gap-1 text-md text-text-muted">
            <span className="shrink-0">
              <Icon icon={Info} size={16} />
            </span>
            {t('exportImg.capped')}
          </p>
        ) : conflict !== null ? (
          <div className="mt-4 flex flex-col gap-2" role="group" aria-labelledby={`${id}-conflict`}>
            <h3 id={`${id}-conflict`} className="m-0 text-md font-semibold">
              {t('exportImg.conflictTitle')}
            </h3>
            <p className="m-0 text-text-muted">{t('exportImg.conflictBody', { count: conflict.count })}</p>
            <ul className="m-0 list-none p-0 text-sm tabular-nums">
              {conflict.names.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
              {conflict.count > conflict.names.length && <li aria-hidden="true">…</li>}
            </ul>
          </div>
        ) : (
          <div ref={body} className="relative mt-4">
            <div className={`flex flex-col gap-4 ${busy ? 'invisible' : ''}`} inert={busy ? true : undefined}>
              <div>
                <div className={labelClass}>{t('exportImg.format')}</div>
                <RadioGroup
                  label={t('exportImg.format')}
                  look="segmented"
                  orientation="horizontal"
                  value={format}
                  onChange={(value) => {
                    setFormat(value);
                    remember({ format: value });
                  }}
                  options={(['png', 'jpeg'] as const).map((value) => ({
                    value,
                    label: FORMAT_NAMES[value],
                    content: FORMAT_NAMES[value],
                  }))}
                />
              </div>
              <div>
                <div className={labelClass}>{t('exportImg.pages')}</div>
                <RadioGroup
                  label={t('exportImg.pages')}
                  look="plain"
                  orientation="vertical"
                  value={mode}
                  onChange={setMode}
                  options={modes.map((m) => ({ value: m.value, label: m.label, content: m.label }))}
                />
                <Field
                  autoComplete="off"
                  spellCheck={false}
                  disabled={mode !== 'range'}
                  aria-label={t('split.rangesLabel')}
                  aria-invalid={rangeInvalid ? true : undefined}
                  aria-describedby={rangeInvalid ? rangeErrorId : undefined}
                  placeholder={t('split.placeholder')}
                  value={rangeText}
                  onChange={(event) => setRangeText(event.target.value)}
                  className="mt-1 w-full"
                />
                <div className="flex h-4 items-center text-sm text-error-text">
                  {rangeInvalid && (
                    <p id={rangeErrorId} className="m-0">
                      {t('split.invalid', { n: slots.length })}
                    </p>
                  )}
                </div>
              </div>
              <div>
                <div className={labelClass}>{t('exportImg.resolution')}</div>
                <div className="flex items-center gap-2">
                  <RadioGroup
                    label={t('exportImg.resolution')}
                    look="segmented"
                    orientation="horizontal"
                    value={custom ? 'custom' : (`${dpi}` as DpiChoice)}
                    onChange={pickDpi}
                    className="flex-auto"
                    options={dpiOptions.map((o) => ({ value: o.value, label: o.label, content: o.label }))}
                  />
                  <Field
                    inputMode="numeric"
                    autoComplete="off"
                    align="end"
                    disabled={!custom}
                    aria-label={t('exportImg.customDpi')}
                    aria-invalid={dpiInvalid ? true : undefined}
                    aria-describedby={dpiInvalid ? dpiErrorId : undefined}
                    value={dpiText}
                    onChange={(event) => editDpi(event.target.value)}
                    onKeyDown={onDpiKey}
                    className="w-field shrink-0"
                  />
                  <span className="shrink-0 text-sm text-text-muted">{t('exportImg.dpi')}</span>
                </div>
                <div className="flex h-4 items-center text-sm text-error-text">
                  {dpiInvalid && (
                    <p id={dpiErrorId} className="m-0">
                      {t('exportImg.dpiInvalid')}
                    </p>
                  )}
                </div>
              </div>
              <div role="group" aria-labelledby={`${id}-quality`} aria-disabled={format === 'png' ? true : undefined}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span id={`${id}-quality`} className="text-sm font-semibold text-text-muted">
                    {t('exportImg.quality')}
                  </span>
                  {format === 'png' && <span className="text-sm text-text-muted">{t('exportImg.pngLossless')}</span>}
                </div>
                <Slider
                  label={t('exportImg.quality')}
                  hideLabel
                  min={QUALITY_MIN}
                  max={QUALITY_MAX}
                  step={1}
                  value={quality}
                  disabled={format === 'png'}
                  format={(value) => t('exportImg.qualityValue', { n: value })}
                  onValueChange={setQuality}
                  onValueCommit={(value) => remember({ quality: value })}
                />
              </div>
              <label className="flex min-h-control-md cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={annotations}
                  onChange={(event) => setAnnotations(event.target.checked)}
                  className="accent-accent"
                />
                {t('exportImg.annotations')}
              </label>
              <p role="status" aria-live="polite" className="m-0 min-h-6 text-sm text-text-muted">
                {estimate !== null &&
                  t('exportImg.estimateSize', {
                    images: t('exportImg.estimate', { count: estimate.count }),
                    size: formatSize(estimate.bytes, locale),
                  })}
              </p>
            </div>
            {busy && (
              <div className="absolute inset-0 flex flex-col justify-center gap-2">
                <ProgressBar label={t('exportImg.working')} done={progress?.done ?? 0} total={progress?.total ?? 0} />
                <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
                  {progress !== null && progress.total > 0
                    ? t('exportImg.progress', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
                    : t('exportImg.working')}
                </p>
              </div>
            )}
          </div>
        )}
        <JobError error={run.error} />
        <div className="flex min-h-6 items-center gap-1 text-sm text-text-muted">
          {!mayCopy ? (
            <p role="status" className="m-0">
              {t('output.notAllowed')}
            </p>
          ) : (
            hasMarks && (
              <>
                <Icon icon={Info} size={16} />
                <p className="m-0">{t('output.pendingRedact')}</p>
              </>
            )
          )}
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          {lowered ? (
            <Button variant="primary" data-autofocus="" onClick={close}>
              {t('copy.close')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={cancel}>
              {t('output.cancel')}
            </Button>
          )}
          {lowered ? null : conflict !== null ? (
            <>
              <Button variant="secondary" onClick={() => resolve('replace')}>
                {t('exportImg.replace')}
              </Button>
              <Button variant="primary" data-autofocus="" onClick={() => resolve('keepBoth')}>
                {t('exportImg.keepBoth')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              type="submit"
              disabled={!canGo}
              focusableWhenDisabled
              aria-busy={busy ? true : undefined}
              aria-label={busy ? t('exportImg.working') : undefined}
            >
              {busy ? <Spinner /> : t('exportImg.go')}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** The Export as images dialog (DESIGN 3.42), open while `useUi.exportImagesOpen`. */
export function ExportImagesDialog() {
  const open = useUi((state) => state.exportImagesOpen);
  return <AnimatePresence>{open && <ExportImagesModal key="export-images" />}</AnimatePresence>;
}
