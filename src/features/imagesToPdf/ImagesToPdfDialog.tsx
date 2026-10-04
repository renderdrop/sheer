import { Images } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { toAppError, type AppError } from '../../api/errors';
import { imagesToPdf, listImageBatch, pickImages, type BatchItem } from '../../api/imagesToPdf';
import { Button, Icon } from '../../components';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { JobError, Spinner } from '../jobs/JobFooter';
import { Modal, ModalHeader } from '../jobs/Modal';
import { ProgressBar } from '../jobs/ProgressBar';
import { RadioGroup } from '../jobs/RadioGroup';
import { useJobRun } from '../jobs/useJobRun';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { ImageList } from './ImageList';
import {
  MARGINS,
  ORIENTATIONS,
  PAPERS,
  defaultPaper,
  loadChoices,
  saveChoices,
  toOptions,
  type PageChoices,
} from './options';
import { closeImagesToPdf, releaseDropped, useImagesToPdf } from './state';

function ImagesModal() {
  const t = useT();
  const id = useId();
  const dropped = useImagesToPdf((state) => state.dropped);
  const [choices, setChoices] = useState<PageChoices>(() => {
    const stored = loadChoices();
    return { paper: stored.paper ?? 'a4', orientation: stored.orientation ?? 'auto', margin: stored.margin ?? 'small' };
  });
  const run = useJobRun();
  const [entries, setEntries] = useState<BatchItem[]>([]);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const [picking, setPicking] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const seen = useRef(new Set<number>());
  const loaded = useRef<number | null>(null);
  // Only a dialog that opens without a batch picks; a batch let go later (used, cancelled) must not start a pick while it closes.
  const started = useRef(dropped !== null);
  const batch = dropped?.batch ?? null;
  const count = dropped?.count ?? 0;

  // Opened from a menu: Rust's open dialog runs first; cancelling it with no images closes everything (DESIGN 3.43).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setPicking(true);
    pickImages()
      .then((picked) => {
        if (picked === null) closeImagesToPdf();
        else
          useImagesToPdf.getState().setDropped({ batch: picked.batch, count: picked.count, skipped: picked.skipped });
      })
      .catch((caught: unknown) => {
        setListError(toAppError(caught));
        closeImagesToPdf();
      })
      .finally(() => setPicking(false));
  }, []);

  // The list follows the batch: a new batch starts over, more images are appended, removed ones stay removed.
  useEffect(() => {
    if (batch === null) return;
    if (loaded.current !== batch) {
      loaded.current = batch;
      seen.current = new Set();
      setEntries([]);
      setFailed(new Set());
    }
    let live = true;
    listImageBatch(batch)
      .then((items) => {
        if (!live) return;
        const fresh = items.filter((item) => !seen.current.has(item.index));
        for (const item of fresh) seen.current.add(item.index);
        setEntries((current) => [...current, ...fresh]);
      })
      .catch((caught: unknown) => {
        if (live) setListError(toAppError(caught));
      });
    return () => {
      live = false;
    };
  }, [batch, count]);

  const add = () => {
    if (batch === null || picking) return;
    setPicking(true);
    setListError(null);
    pickImages(batch)
      .then((picked) => {
        if (picked === null) return;
        useImagesToPdf.getState().setDropped({ batch: picked.batch, count: picked.count, skipped: picked.skipped });
      })
      .catch((caught: unknown) => setListError(toAppError(caught)))
      .finally(() => setPicking(false));
  };

  const onFail = (index: number) => setFailed((current) => new Set(current).add(index));

  // Without an earlier choice the OS region picks the paper (A4, or Letter in the US and Canada).
  useEffect(() => {
    if (loadChoices().paper !== undefined) return;
    let live = true;
    void defaultPaper().then((paper) => {
      if (live) setChoices((current) => ({ ...current, paper }));
    });
    return () => {
      live = false;
    };
  }, []);

  // A batch the dialog still holds when it goes away (Esc, backdrop, the flag set elsewhere) is let go.
  useEffect(() => releaseDropped, []);

  const choose = (patch: Partial<PageChoices>) => {
    const next = { ...choices, ...patch };
    setChoices(next);
    saveChoices(next);
  };

  const canCreate = batch !== null && entries.length > 0 && failed.size === 0 && !picking && !run.running;

  const go = () => {
    if (run.running) return;
    if (batch === null || !canCreate) return;
    const source = { type: 'batch', batch } as const;
    run.start(
      (onEvent) =>
        imagesToPdf(
          toOptions(source, choices),
          onEvent,
          entries.map((entry) => entry.index),
        ),
      (event) => {
        // The backend used the batch; it is not released again.
        useImagesToPdf.getState().setDropped(null);
        if (event.opened !== null) adoptOpenOutcomes([{ type: 'opened', document: event.opened }]);
        closeImagesToPdf();
        const skipped = event.skipped ?? 0;
        if (skipped > 0 || event.warnings.includes('imagesSkipped')) {
          useUi.getState().showToast({ message: t('img2pdf.skipped', { count: Math.max(skipped, 1) }) });
        }
      },
    );
  };

  const cancel = () => (run.running ? run.cancel() : closeImagesToPdf());
  const progress = run.progress;
  const fit = choices.paper === 'fit';
  const names = {
    fit: t('img2pdf.fit'),
    a4: 'A4',
    letter: 'Letter',
    auto: t('img2pdf.auto'),
    portrait: t('img2pdf.portrait'),
    landscape: t('img2pdf.landscape'),
    none: t('img2pdf.none'),
    small: t('img2pdf.small'),
    large: t('img2pdf.large'),
  };
  const options = <V extends keyof typeof names>(values: readonly V[]) =>
    values.map((value) => ({ value, label: names[value], content: names[value] }));
  const label = 'm-0 mb-0-5 text-sm font-semibold text-text-muted';
  const busy = run.running;
  const dim = fit ? 'opacity-60' : '';

  return (
    <Modal labelledBy={`${id}-title`} width="w-sheet" onClose={cancel}>
      <ModalHeader id={`${id}-title`} icon={<Icon icon={Images} />} title={t('img2pdf.title')} />
      {dropped !== null && dropped.skipped > 0 && (
        <p role="status" className="m-0 mt-0-5 text-sm text-warning-text">
          {t('img2pdf.skipped', { count: dropped.skipped })}
        </p>
      )}
      {batch !== null && (
        <>
          <ImageList
            batch={batch}
            entries={entries}
            onChange={setEntries}
            failed={failed}
            onFail={onFail}
            disabled={busy}
          />
          <div className="mt-1 flex items-center justify-between gap-1">
            <Button variant="secondary" size="sm" onClick={add} disabled={picking || busy} focusableWhenDisabled>
              {t('img2pdf.add')}
            </Button>
            <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
              {t('img2pdf.total', { count: entries.length })}
            </p>
          </div>
        </>
      )}
      <div className="relative mt-2">
        <div className={busy ? 'invisible' : ''} inert={busy ? true : undefined}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className={label}>{t('img2pdf.size')}</p>
              <RadioGroup
                label={t('img2pdf.size')}
                look="segmented"
                orientation="horizontal"
                value={choices.paper}
                onChange={(paper) => choose({ paper })}
                options={options(PAPERS)}
              />
            </div>
            <div aria-disabled={fit ? 'true' : undefined}>
              <p className={label}>{t('img2pdf.orientation')}</p>
              <div className={dim}>
                <RadioGroup
                  label={t('img2pdf.orientation')}
                  look="segmented"
                  orientation="horizontal"
                  value={choices.orientation}
                  onChange={(orientation) => choose({ orientation })}
                  options={options(ORIENTATIONS)}
                />
              </div>
            </div>
          </div>
          <div className="mt-2" aria-disabled={fit ? 'true' : undefined}>
            <p className={label}>{t('img2pdf.margin')}</p>
            <div className={dim}>
              <RadioGroup
                label={t('img2pdf.margin')}
                look="segmented"
                orientation="horizontal"
                value={choices.margin}
                onChange={(margin) => choose({ margin })}
                options={options(MARGINS)}
              />
            </div>
          </div>
        </div>
        {busy && (
          <div className="absolute inset-0 flex flex-col justify-center gap-1">
            <ProgressBar label={t('img2pdf.title')} done={progress?.done ?? 0} total={progress?.total ?? 0} />
            <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
              {progress !== null && progress.total > 0
                ? t('img2pdf.progress', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
                : t('img2pdf.title')}
            </p>
          </div>
        )}
      </div>
      <JobError error={run.error ?? listError} />
      <div className="mt-2 flex items-center justify-end gap-1">
        <Button variant="secondary" onClick={cancel}>
          {t('output.cancel')}
        </Button>
        <Button
          variant="primary"
          data-autofocus=""
          disabled={!canCreate}
          focusableWhenDisabled
          aria-busy={busy ? true : undefined}
          aria-label={busy ? t('img2pdf.title') : undefined}
          onClick={go}
        >
          {busy ? <Spinner /> : t('img2pdf.create')}
        </Button>
      </div>
    </Modal>
  );
}

/** The Create PDF from images dialog (DESIGN 3.43), open while `useUi.imagesToPdfOpen`. */
export function ImagesToPdfDialog() {
  const open = useUi((state) => state.imagesToPdfOpen);
  return <AnimatePresence>{open && <ImagesModal key="images" />}</AnimatePresence>;
}
