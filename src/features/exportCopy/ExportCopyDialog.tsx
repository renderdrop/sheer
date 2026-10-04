import { CircleAlert, FileOutput } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useState } from 'react';

import { exportPdf, type PdfExportOptions } from '../../api/exportPdf';
import type { JobWarning } from '../../api/jobs';
import type { SaveAck } from '../../api/save';
import { Button, Icon } from '../../components';
import { useT } from '../../i18n';
import { selectActiveDocument, selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { JobError, Spinner } from '../jobs/JobFooter';
import { Modal, ModalHeader } from '../jobs/Modal';
import { ProgressBar } from '../jobs/ProgressBar';
import { RadioGroup } from '../jobs/RadioGroup';
import { useJobRun } from '../jobs/useJobRun';

type Annotations = PdfExportOptions['annotations'];

const close = (): void => useUi.getState().setExportCopyOpen(false);

/** The warnings of a finished export this dialog can say, with their catalog keys. */
const WARNING_KEYS = { signaturesRemoved: 'copy.warn.signaturesRemoved' } as const;

/** Whether the permission list of a restricted file allows editing; a file without restrictions (`null`) allows everything. */
export function canEditCopy(permissions: readonly string[] | null | undefined): boolean {
  return permissions === null || permissions === undefined || permissions.includes('edit');
}

/** The options as sent: without the edit permission only the plain copy is possible. */
export function effectiveOptions(
  annotations: Annotations,
  removeMetadata: boolean,
  canEdit: boolean,
): PdfExportOptions {
  return canEdit ? { annotations, removeMetadata } : { annotations: 'keep', removeMetadata: false };
}

export function exportWarnings(warnings: readonly JobWarning[]): (keyof typeof WARNING_KEYS)[] {
  return (Object.keys(WARNING_KEYS) as (keyof typeof WARNING_KEYS)[]).filter((key) => warnings.includes(key));
}

function ExportModal({ docId }: { docId: number }) {
  const t = useT();
  const id = useId();
  const run = useJobRun();
  const permissions = useDocuments((state) => selectActiveDocument(state)?.flags?.permissions);
  const canEdit = canEditCopy(permissions);
  const [annotations, setAnnotations] = useState<Annotations>('keep');
  const [removeMetadata, setRemoveMetadata] = useState(false);
  const [ack, setAck] = useState<SaveAck>({});
  const [warnings, setWarnings] = useState<(keyof typeof WARNING_KEYS)[] | null>(null);

  const confirming =
    run.error !== null &&
    run.error.code === 'needs_confirmation' &&
    run.error.params?.what === 'rewriteEncrypted' &&
    ack.rewriteEncrypted !== true;
  const finished = warnings !== null;

  const go = (nextAck: SaveAck) => {
    if (run.running) return;
    const opts = effectiveOptions(annotations, removeMetadata, canEdit);
    run.start(
      (onEvent) => exportPdf(docId, opts, nextAck, onEvent),
      (event) => {
        useUi.getState().showToast({ message: t('copy.done') });
        const shown = exportWarnings(event.warnings);
        if (shown.length === 0) close();
        else setWarnings(shown);
      },
    );
  };
  const confirm = () => {
    const next = { ...ack, rewriteEncrypted: true };
    setAck(next);
    go(next);
  };
  const cancel = () => (run.running ? run.cancel() : close());
  const progress = run.progress;

  const option = (value: Annotations, label: string, hint: string) => ({
    value,
    label,
    describedBy: `${id}-hint-${value}`,
    content: <span>{label}</span>,
    hint,
  });
  const options = [
    option('keep', t('copy.keep'), t('copy.keepHint')),
    option('flatten', t('copy.flatten'), t('copy.flattenHint')),
    option('remove', t('copy.remove'), t('copy.removeHint')),
  ];
  const shownAnnotations = canEdit ? annotations : 'keep';
  const hint = options.find((o) => o.value === shownAnnotations)?.hint ?? '';
  const edited = canEdit ? undefined : `${id}-needs`;

  let body;
  let footer;
  if (finished) {
    body = (
      <ul className="m-0 mt-4 flex list-none flex-col gap-1 p-0">
        {warnings.map((key) => (
          <li key={key} className="flex items-start gap-1 text-md text-text">
            <span className="shrink-0">
              <Icon icon={CircleAlert} size={16} />
            </span>
            {t(WARNING_KEYS[key])}
          </li>
        ))}
      </ul>
    );
    footer = (
      <Button variant="primary" data-autofocus="" onClick={close}>
        {t('copy.close')}
      </Button>
    );
  } else if (confirming) {
    body = <p className="m-0 mt-2 text-md text-text-muted">{t('copy.confirmBody')}</p>;
    footer = (
      <>
        <Button variant="secondary" data-autofocus="" onClick={run.clearError}>
          {t('copy.back')}
        </Button>
        <Button variant="primary" onClick={confirm}>
          {t('copy.confirmGo')}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <p className="m-0 mt-2 text-md text-text-muted">{t('copy.unsaved')}</p>
        <p className="m-0 mt-1 text-md text-text-muted">{t('copy.body')}</p>
        <div className="mt-4 flex flex-col gap-2">
          <RadioGroup
            label={t('copy.annotations')}
            value={shownAnnotations}
            options={options}
            onChange={setAnnotations}
            orientation="horizontal"
            look="segmented"
            disabled={run.running || !canEdit}
          />
          <p id={`${id}-hint-${shownAnnotations}`} className="m-0 text-sm text-text-muted">
            {hint}
          </p>
        </div>
        <div className="mt-2 flex flex-col">
          <label className="flex min-h-control-sm cursor-pointer items-center gap-2 text-md has-disabled:cursor-not-allowed has-disabled:text-text-disabled">
            <input
              type="checkbox"
              className="accent-accent"
              checked={canEdit && removeMetadata}
              disabled={run.running || !canEdit}
              aria-describedby={edited}
              onChange={(event) => setRemoveMetadata(event.target.checked)}
            />
            {t('copy.metadata')}
          </label>
          <p className="m-0 min-h-4 ps-6 text-sm text-text-muted">
            {canEdit && removeMetadata ? t('copy.metadataHint') : ''}
          </p>
        </div>
        {!canEdit && (
          <p id={`${id}-needs`} className="m-0 flex items-start gap-1 text-sm text-text-muted">
            <span className="shrink-0">
              <Icon icon={CircleAlert} size={16} />
            </span>
            {t('output.notAllowed')} {t('copy.needsEdit')}
          </p>
        )}
        <div className="mt-2 flex min-h-4 flex-col justify-center gap-2">
          {run.running && (
            <>
              <ProgressBar label={t('copy.working')} done={progress?.done ?? 0} total={progress?.total ?? 0} />
              <p role="status" className="m-0 text-sm text-text-muted tabular-nums">
                {progress !== null && progress.total > 0
                  ? t('copy.progress', { i: Math.min(progress.done + 1, progress.total), n: progress.total })
                  : t('copy.working')}
              </p>
            </>
          )}
        </div>
        <JobError error={run.error} />
      </>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={cancel}>
          {t('output.cancel')}
        </Button>
        <Button
          variant="primary"
          data-autofocus=""
          disabled={run.running}
          focusableWhenDisabled
          aria-busy={run.running ? true : undefined}
          aria-label={run.running ? t('copy.working') : undefined}
          onClick={() => go(ack)}
        >
          {run.running ? <Spinner /> : t('copy.go')}
        </Button>
      </>
    );
  }

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={finished ? close : cancel}>
      <ModalHeader
        id={`${id}-title`}
        icon={<Icon icon={FileOutput} />}
        title={finished ? t('copy.doneTitle') : confirming ? t('copy.confirmTitle') : t('copy.title')}
      />
      {body}
      <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>
    </Modal>
  );
}

/**
 * The Export a copy dialog (DESIGN 3.45, dialog 3.19), open while `useUi.exportCopyOpen`. A segmented choice for comments and markup
 * (keep, flatten, remove) and the metadata option, then Rust's Save As; the open document stays as it is. A protected file asks once
 * before it is rewritten, the warning of the job (signatures removed) is shown after it, and a restricted file without the edit
 * permission can only be copied as it is.
 */
export function ExportCopyDialog() {
  const open = useUi((state) => state.exportCopyOpen);
  const docId = useDocuments(selectActiveId);
  useEffect(() => {
    if (open && docId === null) close();
  }, [open, docId]);
  return (
    <AnimatePresence>{open && docId !== null && <ExportModal key={`copy-${docId}`} docId={docId} />}</AnimatePresence>
  );
}
