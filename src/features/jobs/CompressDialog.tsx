import { FileArchive } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { closeDocument } from '../../api/documents';
import { compressDocument, estimateCompression, type CompressEstimate, type CompressPreset } from '../../api/jobs';
import { Button, Icon } from '../../components';
import { formatNumber, useLocale, useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { JobError, Spinner } from './JobFooter';
import { Modal, ModalHeader } from './Modal';
import { ProgressBar } from './ProgressBar';
import { RadioGroup } from './RadioGroup';
import { formatSize } from './ranges';
import { closeSheet } from './state';
import { useJobRun } from './useJobRun';

export type PresetId = 'small' | 'balanced' | 'high';
type After = 'new' | 'file';

/** The preset of the design (DESIGN 3.31) and the backend preset it runs: 96 dpi / q 50, 150 / 70, 220 / 85. */
const BACKEND_PRESET: Record<PresetId, CompressPreset> = { small: 'screen', balanced: 'ebook', high: 'print' };
const PRESETS: readonly PresetId[] = ['small', 'balanced', 'high'];
const STORAGE_KEY = 'compress.preset';
/** Less than this saving counts as "little to gain" (DESIGN 3.31). */
export const LITTLE_GAIN = 0.05;

function loadPreset(): PresetId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return PRESETS.find((preset) => preset === stored) ?? 'balanced';
  } catch {
    return 'balanced';
  }
}

function savePreset(preset: PresetId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // Not remembered; harmless.
  }
}

function CompressModal() {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const doc = useDocuments(selectActiveDocument);
  const [preset, setPreset] = useState<PresetId>(loadPreset);
  const [after, setAfter] = useState<After>('new');
  // undefined: still estimating; null: no estimate available.
  const [estimate, setEstimate] = useState<CompressEstimate | null | undefined>(undefined);
  const [noGain, setNoGain] = useState(false);
  const run = useJobRun();
  const docId = doc?.id ?? null;

  useEffect(() => {
    if (docId === null) return;
    let live = true;
    estimateCompression(docId).then(
      (value) => live && setEstimate(value),
      () => live && setEstimate(null),
    );
    return () => {
      live = false;
    };
  }, [docId]);

  const choose = (value: PresetId) => {
    setPreset(value);
    savePreset(value);
  };

  const go = () => {
    if (docId === null || run.running) return;
    run.start(
      (onEvent) => compressDocument(docId, BACKEND_PRESET[preset], onEvent, after === 'file'),
      (event) => {
        const smaller = event.bytesAfter < event.bytesBefore;
        if (!smaller) {
          // Nothing opens; a document the job already made is dropped again.
          if (event.opened !== null) closeDocument(event.opened.id, true).catch(() => undefined);
          setNoGain(true);
          return;
        }
        if (event.opened !== null) adoptOpenOutcomes([{ type: 'opened', document: event.opened }]);
        closeSheet();
        useUi.getState().showToast({ message: t('compress.done', { size: formatSize(event.bytesAfter, locale) }) });
      },
    );
  };

  const estimateText = (value: PresetId): string | null => {
    if (estimate === undefined || estimate === null) return null;
    const bytes = estimate.presets[BACKEND_PRESET[value]];
    const gain = estimate.current > 0 ? 1 - bytes / estimate.current : 0;
    if (gain < LITTLE_GAIN) return t('compress.little');
    return t('compress.estimate', {
      size: formatSize(bytes, locale),
      pct: formatNumber(Math.round(gain * 100), locale),
    });
  };

  const names: Record<PresetId, string> = {
    small: t('compress.small'),
    balanced: t('compress.balanced'),
    high: t('compress.high'),
  };
  const hints: Record<PresetId, string> = {
    small: t('compress.smallHint'),
    balanced: t('compress.balancedHint'),
    high: t('compress.highHint'),
  };

  const cancel = () => (run.running ? run.cancel() : closeSheet());
  const progress = run.progress;

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={cancel}>
      <ModalHeader id={`${id}-title`} icon={<Icon icon={FileArchive} />} title={t('compress.title')} />
      {estimate !== undefined && estimate !== null && (
        <p className="m-0 mt-2 text-sm text-text-muted">
          {t('compress.now', { size: formatSize(estimate.current, locale) })}
        </p>
      )}
      {/* The body keeps its height while the job runs: the presets only become invisible under the bar. */}
      <div className="relative mt-4">
        <div className={run.running || noGain ? 'invisible' : ''} inert={run.running || noGain ? true : undefined}>
          <RadioGroup
            label={t('compress.presets')}
            look="rows"
            orientation="vertical"
            value={preset}
            onChange={choose}
            options={PRESETS.map((value) => ({
              value,
              label: names[value],
              content: (
                <span className="flex w-full items-center gap-2">
                  <span className="flex min-w-0 flex-auto flex-col">
                    <span className="font-semibold">{names[value]}</span>
                    <span className="text-sm font-normal text-text-muted">{hints[value]}</span>
                  </span>
                  <span className="shrink-0 text-sm font-normal tabular-nums">
                    {estimate === undefined ? (
                      <span role="img" aria-label={t('compress.estimating')}>
                        <Spinner size={12} />
                      </span>
                    ) : (
                      estimateText(value)
                    )}
                  </span>
                </span>
              ),
            }))}
          />
          <RadioGroup
            label={t('compress.after')}
            look="plain"
            orientation="vertical"
            value={after}
            onChange={setAfter}
            className="mt-3"
            options={[
              { value: 'new', label: t('compress.openNew'), content: t('compress.openNew') },
              { value: 'file', label: t('compress.saveAs'), content: t('compress.saveAs') },
            ]}
          />
        </div>
        {(run.running || noGain) && (
          <div className="absolute inset-0 flex flex-col justify-center gap-2">
            {run.running ? (
              <>
                <ProgressBar label={t('compress.working')} done={progress?.done ?? 0} total={progress?.total ?? 0} />
                <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
                  {progress !== null && progress.total > 0
                    ? t('compress.progress', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
                    : t('compress.working')}
                </p>
              </>
            ) : (
              <p role="status" className="m-0 text-md text-text-muted">
                {t('compress.noGain')}
              </p>
            )}
          </div>
        )}
      </div>
      <JobError error={run.error} />
      <div className="mt-4 flex items-center justify-end gap-2">
        {noGain ? (
          <Button variant="primary" data-autofocus="" onClick={closeSheet}>
            {t('compress.close')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={cancel}>
              {t('compress.cancel')}
            </Button>
            <Button
              variant="primary"
              data-autofocus=""
              disabled={run.running || docId === null}
              focusableWhenDisabled
              aria-busy={run.running ? true : undefined}
              aria-label={run.running ? t('compress.working') : undefined}
              onClick={go}
            >
              {run.running ? <Spinner /> : t('compress.go')}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The compress dialog (DESIGN 3.31). */
export function CompressDialog() {
  return <CompressModal />;
}
