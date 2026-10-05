import { CircleAlert, Lock } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useMemo, useState } from 'react';

import { SEAL_LOCATION_MAX, SEAL_REASON_MAX } from '../../../api/signing';
import { announce, Button, Field, Icon } from '../../../components';
import { useT } from '../../../i18n';
import { errorText } from '../../../i18n/errors';
import { isDirty, useAnnotations } from '../../../stores/annotations';
import { useDocuments } from '../../../stores/documents';
import { useUi } from '../../../stores/ui';
import { Modal, ModalHeader } from '../../jobs/Modal';
import { canSign, useIdentities } from './identities';
import { signWithCertificate } from './run';
import { SealPreview, sealDate } from './SealPreview';
import { useCertSign } from './store';

/** The confirmation sheet of the certificate signing flow (DESIGN 3.8 S3 steps 2 to 4). */
function SignSheet() {
  const t = useT();
  const id = useId();
  const box = useCertSign((state) => state.box);
  const certId = useCertSign((state) => state.identityId);
  const identities = useIdentities((state) => state.items);
  const document = useDocuments((state) => (box === null ? undefined : state.byId[box.docId]));
  const dirty = useAnnotations((state) => isDirty(state, box?.docId ?? null));
  const [signerId, setSignerId] = useState(certId ?? identities.find(canSign)?.id ?? '');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const identity = identities.find((entry) => entry.id === signerId);
  const date = useMemo(() => sealDate(new Date()), []);

  // The placeholder stays when the dialog closes (S3); without a placeholder there is nothing to confirm.
  const close = () => useCertSign.getState().closeDialog();
  useEffect(() => {
    if (box === null) useCertSign.getState().closeDialog();
  }, [box]);

  if (box === null) return null;
  const expired = identity !== undefined && !canSign(identity);
  const ready = identity !== undefined && !expired && !dirty && !busy;

  const submit = async () => {
    if (identity === undefined || !ready) return;
    setBusy(true);
    setFailure(null);
    const outcome = await signWithCertificate({ identity, box, reason, location });
    setBusy(false);
    if (outcome.type === 'cancelled') return; // The save dialog was cancelled: back here, nothing written.
    if (outcome.type === 'failed') {
      setFailure(t('sign.cert.failed', { reason: errorText(t, outcome.error) }));
      return;
    }
    const file = outcome.result.document.displayName;
    useCertSign.getState().reset();
    useUi.getState().releaseTool();
    useUi.getState().showToast({ message: t('sign.cert.done', { file }) });
    announce(t('sign.cert.done', { file }));
  };

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={() => !busy && close()}>
      <ModalHeader id={`${id}-title`} icon={<Icon icon={Lock} />} title={t('sign.cert.title')} />
      <div className="mt-4 flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="t-label">{t('sign.cert.signer')}</span>
          <select
            data-autofocus=""
            value={signerId}
            disabled={busy}
            onChange={(event) => setSignerId(event.target.value)}
            className="h-control-lg rounded-button border border-border bg-card px-2 text-md text-text"
          >
            {identities.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!canSign(entry)}>
                {entry.subject.commonName}
              </option>
            ))}
          </select>
          {identity !== undefined && (
            <span className={`t-caption ${expired ? 'text-error-text' : 'text-text-muted'}`}>
              {expired
                ? t('cert.expired', { date: identity.notAfter.slice(0, 10) })
                : t('cert.validUntil', { date: identity.notAfter.slice(0, 10) })}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="t-label">{t('sign.cert.reason')}</span>
          <Field
            className="w-full!"
            value={reason}
            maxLength={SEAL_REASON_MAX}
            disabled={busy}
            placeholder={t('sign.cert.reasonPlaceholder')}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="t-label">{t('sign.cert.location')}</span>
          <Field
            className="w-full!"
            value={location}
            maxLength={SEAL_LOCATION_MAX}
            disabled={busy}
            onChange={(event) => setLocation(event.target.value)}
          />
        </label>
        <SealPreview name={identity?.subject.commonName ?? ''} date={date} reason={reason} />
        <div className="flex flex-col gap-1 rounded-card bg-card p-3">
          <p className="t-label m-0 flex items-start gap-2 text-text">
            <span className="shrink-0">
              <Icon icon={Lock} size={16} />
            </span>
            {t('sign.cert.lockNotice')}
          </p>
          {dirty && <p className="t-caption m-0 text-text-muted">{t('error.unsaved_changes')}</p>}
          {document?.flags?.signed === true && (
            <p className="t-caption m-0 text-text-muted">{t('sign.cert.existing')}</p>
          )}
          <p className="t-caption m-0 text-text-muted">{t('sign.cert.notQualified')}</p>
        </div>
      </div>
      <div className="mt-4 flex min-h-4 items-start text-sm text-error-text">
        {failure !== null && (
          <p role="alert" className="m-0 flex items-start gap-1">
            <span className="shrink-0">
              <Icon icon={CircleAlert} size={16} />
            </span>
            {failure}
          </p>
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={close}>
          {t('save.cancel')}
        </Button>
        <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
          {busy ? t('sign.cert.signing') : failure !== null ? t('comments.retry') : t('sign.cert.submit')}
        </Button>
      </div>
    </Modal>
  );
}

/** Shows the confirmation sheet while it is open. Mount it once with the shell. */
export function SignDialogHost() {
  const open = useCertSign((state) => state.dialog && state.box !== null);
  return <AnimatePresence>{open && <SignSheet key="cert-sign" />}</AnimatePresence>;
}
