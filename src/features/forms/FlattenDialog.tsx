import { Stamp } from 'lucide-react';
import { useId } from 'react';

import { flattenDocument } from '../../api/jobs';
import { Button, Icon } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { JobError, Spinner } from '../jobs/JobFooter';
import { Modal, ModalHeader } from '../jobs/Modal';
import { ProgressBar } from '../jobs/ProgressBar';
import { useJobRun } from '../jobs/useJobRun';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { useForms } from './store';

const close = (): void => useForms.getState().setFlattenOpen(false);

/**
 * The flatten confirmation (DESIGN 3.32, dialog 3.19): `stamp` tile and title, the explanation, Cancel (initial focus) and the
 * primary action. The job is a new-file job (ADR-041): Rust asks where to save, rewrites the file with the fields baked into the
 * pages and the result opens. A progress bar shows while it runs; Cancel stops it.
 */
export function FlattenDialog() {
  const t = useT();
  const id = useId();
  const docId = useDocuments(selectActiveId);
  const run = useJobRun();

  const go = () => {
    if (docId === null || run.running) return;
    run.start(
      (onEvent) => flattenDocument(docId, { scope: 'forms' }, onEvent),
      (event) => {
        if (event.opened !== null) adoptOpenOutcomes([{ type: 'opened', document: event.opened }]);
        close();
        useUi.getState().showToast({ message: t('form.flattened') });
      },
    );
  };
  const cancel = () => (run.running ? run.cancel() : close());
  const progress = run.progress;

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={cancel}>
      <ModalHeader id={`${id}-title`} icon={<Icon icon={Stamp} />} title={t('form.flattenTitle')} />
      <p className="m-0 mt-1 text-md text-text-muted">{t('form.flattenBody')}</p>
      <div className="mt-2 flex min-h-2 flex-col justify-center gap-1">
        {run.running && (
          <>
            <ProgressBar label={t('form.working')} done={progress?.done ?? 0} total={progress?.total ?? 0} />
            <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
              {progress !== null && progress.total > 0
                ? t('form.progress', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
                : t('form.working')}
            </p>
          </>
        )}
      </div>
      <JobError error={run.error} />
      <div className="mt-2 flex items-center justify-end gap-1">
        <Button variant="secondary" data-autofocus="" onClick={cancel}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={run.running || docId === null}
          focusableWhenDisabled
          aria-busy={run.running ? true : undefined}
          aria-label={run.running ? t('form.working') : undefined}
          onClick={go}
        >
          {run.running ? <Spinner /> : t('form.flattenGo')}
        </Button>
      </div>
    </Modal>
  );
}
