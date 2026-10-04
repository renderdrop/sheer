import { Info, Printer } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { toAppError, type AppError } from '../../api/errors';
import type { PageSelection } from '../../api/pageSelection';
import { preparePrint, releasePrint } from '../../api/print';
import { Button, Field, Icon, Checkbox } from '../../components';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { marksOf, useRedact } from '../redact/store';
import { JobError, Spinner } from '../jobs/JobFooter';
import { Modal, ModalHeader } from '../jobs/Modal';
import { ProgressBar } from '../jobs/ProgressBar';
import { RadioGroup } from '../jobs/RadioGroup';
import { parseRanges } from '../jobs/ranges';
import { useJobRun } from '../jobs/useJobRun';
import { clearSurface, fetchFrames, handOver, stageFrames, usePrintSurface } from './session';

type Pages = 'all' | 'current' | 'range';
type Quality = 'standard' | 'high';

const ANNOTATIONS_KEY = 'print.annotations';
const QUALITY_KEY = 'print.quality';

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return allowed.find((value) => value === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; harmless.
  }
}

const close = (): void => useUi.getState().setPrintOpen(false);

function PrintModal() {
  const t = useT();
  const id = useId();
  const doc = useDocuments(selectActiveDocument);
  const docId = doc?.id ?? null;
  const total = doc?.pageCount ?? 0;
  const pageIndex = useView((state) => (docId === null ? 0 : (state.byDoc[docId]?.pageIndex ?? 0)));
  const hasMarks = useRedact((state) => marksOf(state, docId).length > 0);
  const printing = usePrintSurface((state) => state.printing === true);
  const permissions = doc?.flags?.permissions;
  const allowed = permissions === undefined || permissions === null || permissions.includes('print');

  const [annotations, setAnnotations] = useState(() => load(ANNOTATIONS_KEY, ['on', 'off'], 'on') === 'on');
  const [quality, setQuality] = useState<Quality>(() => load(QUALITY_KEY, ['standard', 'high'], 'standard'));
  const [pages, setPages] = useState<Pages>('all');
  const [rangeText, setRangeText] = useState('');
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const run = useJobRun();
  const cancelled = useRef(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      cancelled.current = true;
    };
  }, []);

  const busy = run.running || loading !== null;
  const rangeValid = pages !== 'range' || (rangeText.trim() !== '' && parseRanges(rangeText, total) !== null);
  const rangeInvalid = pages === 'range' && rangeText.trim() !== '' && !rangeValid;
  const canGo = allowed && docId !== null && rangeValid && !busy && !printing;

  const finishSet = (printId: number) => {
    clearSurface();
    releasePrint(printId).catch(() => undefined);
  };

  const go = () => {
    if (!canGo || docId === null) return;
    const selection: PageSelection =
      pages === 'all'
        ? { type: 'all' }
        : { type: 'ranges', text: pages === 'current' ? String(pageIndex + 1) : rangeText };
    cancelled.current = false;
    setError(null);
    run.start(
      (onEvent) =>
        preparePrint(docId, { pages: selection, annotations, quality, autoRotate: true, paper: 'portrait' }, onEvent),
      async (event) => {
        const set = event.print;
        if (set === null || set === undefined || set.pages < 1) {
          // Never hand over a blank print; a set with no pages is dropped.
          if (set !== null && set !== undefined) releasePrint(set.printId).catch(() => undefined);
          if (live.current) setError(toAppError(null));
          return;
        }
        if (cancelled.current) {
          releasePrint(set.printId).catch(() => undefined);
          return;
        }
        setLoading({ done: 0, total: set.pages });
        try {
          const frames = await fetchFrames(
            set.printId,
            set.pages,
            (done) => live.current && setLoading({ done, total: set.pages }),
            () => cancelled.current,
          );
          if (frames === null) {
            releasePrint(set.printId).catch(() => undefined);
            return;
          }
          await stageFrames(frames);
          if (cancelled.current) {
            finishSet(set.printId);
            return;
          }
          // The dialog closes; the native dialog takes over and the set is dropped once it returns.
          close();
          void handOver(set.printId);
        } catch (caught) {
          finishSet(set.printId);
          if (live.current) setError(toAppError(caught));
        } finally {
          if (live.current) setLoading(null);
        }
      },
    );
  };

  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  // Primary+P inside the pre-step prints with the choices as they are.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        goRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cancel = () => {
    if (run.running) {
      cancelled.current = true;
      run.cancel();
    } else if (loading !== null) cancelled.current = true;
    close();
  };

  const progress = loading ?? run.progress;
  const caption =
    progress !== null && progress.total > 0
      ? t('print.preparing', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
      : t('print.title');

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={cancel}>
      <ModalHeader id={`${id}-title`} icon={<Icon icon={Printer} />} title={t('print.title')} />
      <div className="relative mt-4">
        <div className={busy ? 'invisible' : ''} inert={busy ? true : undefined}>
          <label className="flex min-h-control-sm cursor-pointer items-center gap-2 text-md">
            <Checkbox
              checked={annotations}
              aria-describedby={`${id}-hint`}
              onChange={(event) => {
                setAnnotations(event.target.checked);
                save(ANNOTATIONS_KEY, event.target.checked ? 'on' : 'off');
              }}
            />
            {t('print.annotations')}
          </label>
          <p id={`${id}-hint`} className="m-0 text-sm text-text-muted">
            {t('print.annotationsHint')}
          </p>
          <RadioGroup
            label={t('exportImg.pages')}
            look="plain"
            orientation="vertical"
            value={pages}
            onChange={setPages}
            className="mt-2"
            options={[
              { value: 'all', label: t('exportImg.all'), content: t('exportImg.all') },
              { value: 'current', label: t('exportImg.current'), content: t('exportImg.current') },
              { value: 'range', label: t('exportImg.range'), content: t('exportImg.range') },
            ]}
          />
          {pages === 'range' && (
            <>
              <Field
                aria-label={t('exportImg.range')}
                aria-invalid={rangeInvalid ? true : undefined}
                aria-describedby={rangeInvalid ? `${id}-range` : undefined}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('split.placeholder')}
                value={rangeText}
                onChange={(event) => setRangeText(event.target.value)}
                className="mt-1 w-full"
              />
              {rangeInvalid && (
                <p id={`${id}-range`} className="m-0 mt-1 text-sm text-error-text">
                  {t('split.invalid', { n: total })}
                </p>
              )}
            </>
          )}
          <RadioGroup
            label={t('print.quality')}
            look="segmented"
            orientation="horizontal"
            value={quality}
            onChange={(value) => {
              setQuality(value);
              save(QUALITY_KEY, value);
            }}
            className="mt-2"
            options={[
              { value: 'standard', label: t('print.qualityStandard'), content: t('print.qualityStandard') },
              { value: 'high', label: t('print.qualityHigh'), content: t('print.qualityHigh') },
            ]}
          />
        </div>
        {busy && (
          <div className="absolute inset-0 flex flex-col justify-center gap-2">
            <ProgressBar label={t('print.title')} done={progress?.done ?? 0} total={progress?.total ?? 0} />
            <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
              {caption}
            </p>
          </div>
        )}
      </div>
      {!allowed && (
        <p id={`${id}-denied`} role="status" className="m-0 mt-2 text-sm text-text-muted">
          {t('output.notAllowed')}
        </p>
      )}
      <JobError error={error ?? run.error} />
      <div className="flex min-h-6 items-center gap-1 text-sm text-text-muted">
        {hasMarks && (
          <>
            <Icon icon={Info} size={16} />
            <p className="m-0">{t('output.pendingRedact')}</p>
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={cancel}>
          {t('output.cancel')}
        </Button>
        <Button
          variant="primary"
          data-autofocus=""
          disabled={!canGo}
          focusableWhenDisabled
          aria-describedby={allowed ? undefined : `${id}-denied`}
          aria-busy={busy ? true : undefined}
          aria-label={busy ? t('print.title') : undefined}
          onClick={go}
        >
          {busy ? <Spinner /> : t('print.go')}
        </Button>
      </div>
    </Modal>
  );
}

/** The Print pre-step dialog (DESIGN 3.44), open while `useUi.printOpen`. */
export function PrintDialog() {
  const open = useUi((state) => state.printOpen);
  return <AnimatePresence>{open && <PrintModal key="print" />}</AnimatePresence>;
}
