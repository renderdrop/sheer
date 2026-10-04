import { CircleAlert, TriangleAlert } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useState } from 'react';

import { applyRedactions } from '../../api/redaction';
import type { JobWarning } from '../../api/jobs';
import { Button, Icon, pulse } from '../../components';
import { translators, useT } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageNumberOf } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { JobError, Spinner } from '../jobs/JobFooter';
import { Modal } from '../jobs/Modal';
import { ProgressBar } from '../jobs/ProgressBar';
import { useJobRun } from '../jobs/useJobRun';
import { formatPages } from './geometry';
import { markedPages, marksOf, useRedact } from './store';

/** The warnings the redaction job can end with, each with the catalog key that says it. */
const WARNING_KEYS = {
  unsavedEditsDropped: 'redact.unsavedEditsDropped',
  hiddenDataKept: 'redact.hiddenDataKept',
} as const;

/** The warnings of a finished job that this dialog knows how to say. */
export function redactWarnings(warnings: readonly JobWarning[]): (keyof typeof WARNING_KEYS)[] {
  return (Object.keys(WARNING_KEYS) as (keyof typeof WARNING_KEYS)[]).filter((key) => warnings.includes(key));
}

const close = (): void => useRedact.getState().setApplyOpen(false);

/** The success moment (MOTION 4.7): the "Edited" badge pulses with the message, and the toast offers the one-step undo. */
function celebrate(docId: number, pages: readonly number[]): void {
  const t = translators[useLocaleStore.getState().locale];
  const message = t('redact.done');
  useUi.getState().showToast({
    message,
    action: {
      label: t('redact.undo'),
      run: () =>
        void useAnnotations
          .getState()
          .undo(docId)
          .catch(() => undefined),
    },
  });
  // The badge appears with the render that follows the change set.
  requestAnimationFrame(() => {
    const badge = document.querySelector<HTMLElement>('[data-edited]');
    if (badge !== null) pulse(badge, message);
    // The affected thumbnails pulse silently: the badge already announced the message.
    for (const page of pages)
      for (const thumb of document.querySelectorAll<HTMLElement>(`[data-thumb-page="${page}"]`)) pulse(thumb, '');
  });
}

function ApplyModal({ docId }: { docId: number }) {
  const t = useT();
  const id = useId();
  const marks = useRedact((state) => marksOf(state, docId));
  const removeMetadata = useRedact((state) => state.removeMetadata);
  const run = useJobRun();
  const [warnings, setWarnings] = useState<(keyof typeof WARNING_KEYS)[] | null>(null);
  // The pages are fixed when the dialog opens: marks do not change while it is open (the app behind it is inert).
  const [pages] = useState(() => markedPages(marks));
  const progress = run.progress;
  const finished = warnings !== null;
  // One text for the bar's label and the visible line; the line is hidden from AT so it is announced once.
  const progressText =
    progress !== null && progress.total > 0
      ? t('redact.progress', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
      : t('redact.progress', { i: 1, n: pages.length });

  const go = () => {
    if (run.running || pages.length === 0) return;
    run.start(
      (onEvent) => applyRedactions(docId, { pages, removeMetadata }, onEvent),
      (event) => {
        if (event.changes !== undefined && event.changes !== null)
          useAnnotations.getState().applyChanges(docId, event.changes);
        useRedact.getState().select(docId, null);
        celebrate(docId, pages);
        const shown = redactWarnings(event.warnings);
        if (shown.length === 0) close();
        else setWarnings(shown);
      },
    );
  };
  const cancel = () => (run.running ? run.cancel() : close());

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={cancel}>
      <div className="flex items-center gap-2">
        {!finished && (
          <span className="flex size-control-md shrink-0 items-center justify-center text-text">
            <Icon icon={TriangleAlert} />
          </span>
        )}
        <h2 id={`${id}-title`} className="m-0 font-display text-xl">
          {finished ? t('redact.done') : t('redact.confirmTitle')}
        </h2>
      </div>
      {finished ? (
        <div className="mt-2 flex flex-col gap-2">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-md">
            {warnings.map((key) => (
              <li key={key} className="flex items-start gap-1 text-text">
                <span className="shrink-0">
                  <Icon icon={CircleAlert} size={16} />
                </span>
                {t(WARNING_KEYS[key])}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p className="m-0 mt-2 text-md">{t('redact.confirmBody')}</p>
          <p className="m-0 mt-2 text-sm text-text-muted">
            {t('redact.pages', { pages: formatPages(pages.map((page) => pageNumberOf(docId, page))) })}
          </p>
          <div className="mt-2 flex min-h-4 flex-col justify-center gap-2">
            {run.running && (
              <>
                <ProgressBar label={progressText} done={progress?.done ?? 0} total={progress?.total ?? 0} />
                <p aria-hidden="true" className="m-0 text-sm text-text-muted tabular-nums">
                  {progressText}
                </p>
              </>
            )}
          </div>
        </>
      )}
      <JobError error={run.error} />
      <div className="mt-4 flex items-center justify-end gap-2">
        {finished ? (
          <Button variant="primary" data-autofocus="" onClick={close}>
            {t('redact.close')}
          </Button>
        ) : (
          <>
            {/* The initial focus is Cancel: a permanent action is never one Enter away (DESIGN 3.38). */}
            <Button variant="secondary" data-autofocus="" onClick={cancel}>
              {t('redact.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={run.running || pages.length === 0}
              focusableWhenDisabled
              aria-busy={run.running ? true : undefined}
              onClick={go}
            >
              {run.running ? <Spinner /> : t('redact.go', { count: pages.length })}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * The apply dialog (DESIGN 3.38, dialog 3.19): says that redaction is permanent and turns the pages into images, Cancel has the
 * initial focus, the job shows its progress and Cancel stops it without changing anything. On success the dialog closes, the badge
 * pulses and a toast offers Undo (one step until saved); warnings of the job keep the dialog open to be read.
 */
export function RedactApplyDialog() {
  const open = useRedact((state) => state.applyOpen);
  const docId = useDocuments(selectActiveId);
  useEffect(() => {
    // Another document, or none: the dialog is not for it.
    if (open && docId === null) close();
  }, [open, docId]);
  return (
    <AnimatePresence>{open && docId !== null && <ApplyModal key={`apply-${docId}`} docId={docId} />}</AnimatePresence>
  );
}
