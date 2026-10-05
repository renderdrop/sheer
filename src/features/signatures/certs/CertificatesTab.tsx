import { ChevronDown, Copy, Info, KeyRound, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { toAppError } from '../../../api/errors';
import {
  IDENTITIES_MAX,
  pickIdentityFile,
  type IdentityImportTicket,
  type SigningIdentityInfo,
} from '../../../api/signing';
import { Button, Icon, IconButton, announce } from '../../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../../components/dismiss';
import { useLocale, useT } from '../../../i18n';
import { CreateForm, ImportForm } from './CertForms';
import { formatDay, formatMonth, groupHex, notYetValid, certErrorText } from './model';
import {
  addImported,
  canAdd,
  exportCertificate,
  refreshCertificates,
  removeCertificate,
  useCertificates,
} from './state';

type View = 'list' | 'create' | 'import';

/** Moves focus once the list has rendered the element. */
function focusLater(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }));
}

const focusDetails = (id: string) => focusLater(`[data-cert-details="${id}"]`);
const focusAction = (name: 'create' | 'import') => focusLater(`[data-cert-action="${name}"]`);

interface RowProps {
  item: SigningIdentityInfo;
  selected: boolean;
  onDelete: (item: SigningIdentityInfo) => void;
}

function Detail({ label, children }: { label: string; children: string }) {
  return (
    <>
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-md tabular-nums">{children}</dd>
    </>
  );
}

/** One certificate (DESIGN 3.8 S2): key icon, name over meta, Details (expands in place), Delete (inline confirm, no undo). */
function CertRow({ item, selected, onDelete }: RowProps) {
  const t = useT();
  const locale = useLocale();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const name = item.subject.commonName;

  if (confirming) {
    return (
      <li
        data-cert-row={item.id}
        className="flex min-h-[calc(var(--space-12)+var(--space-2))] flex-col justify-center gap-2 rounded-button bg-subtle px-3 py-2"
      >
        <p role="alert" className="m-0 text-md">
          {t('cert.deleteConfirm', { name })}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirming(false)}>
            {t('sign.cancel')}
          </Button>
          <Button variant="secondary" size="sm" className="text-error-text!" onClick={() => onDelete(item)}>
            {t('lib.delete')}
          </Button>
        </div>
      </li>
    );
  }

  const until = t('cert.validUntil', { date: formatMonth(locale, item.notAfter) });
  const origin =
    item.source === 'generated' ? t('cert.selfSigned') : t('cert.imported', { issuer: item.issuer.commonName });
  const future = notYetValid(item);
  const warning = item.expired
    ? t('cert.expired', { date: formatDay(locale, item.notAfter) })
    : future
      ? t('cert.notYetValid', { date: formatDay(locale, item.notBefore) })
      : null;

  const copy = () => {
    // The OS clipboard is local; failing to write it (no permission) is not worth a message.
    void navigator.clipboard?.writeText(item.fingerprintSha256).then(
      () => announce(t('text.copied')),
      () => undefined,
    );
  };

  return (
    <li
      data-cert-row={item.id}
      aria-current={selected ? 'true' : undefined}
      className={`flex flex-col rounded-button hover:bg-subtle focus-within:bg-subtle ${selected ? 'bg-subtle' : ''}`}
    >
      <div className="flex min-h-[calc(var(--space-12)+var(--space-2))] items-center gap-3 px-3">
        <Icon icon={KeyRound} size={20} className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md font-semibold">{name}</span>
          <span className="flex min-w-0 items-center gap-1 text-sm text-text-muted">
            <span className="truncate">{origin}</span>
            {warning === null ? (
              <span className="shrink-0">· {until}</span>
            ) : (
              <span className="flex shrink-0 items-center gap-1 text-text">
                ·
                <Icon icon={TriangleAlert} size={16} />
                {warning}
              </span>
            )}
          </span>
        </div>
        <IconButton
          size="sm"
          icon={ChevronDown}
          label={t('sigs.details')}
          aria-expanded={expanded}
          aria-controls={detailsId}
          data-cert-details={item.id}
          onClick={() => setExpanded((value) => !value)}
          className={expanded ? 'rotate-180' : ''}
        />
        <IconButton size="sm" icon={Trash2} label={t('cert.delete')} onClick={() => setConfirming(true)} />
      </div>
      {expanded && (
        <div id={detailsId} className="flex flex-col gap-2 px-3 pb-3 ps-12">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <Detail label={t('cert.field.name')}>{name}</Detail>
            {item.subject.email !== null && <Detail label={t('cert.field.email')}>{item.subject.email}</Detail>}
            {item.subject.organization !== null && (
              <Detail label={t('cert.field.org')}>{item.subject.organization}</Detail>
            )}
            <Detail label={t('cert.field.issuer')}>{item.issuer.commonName}</Detail>
            <Detail label={t('cert.field.serial')}>{groupHex(item.serialHex)}</Detail>
            <Detail label={t('cert.field.validity')}>
              {`${formatDay(locale, item.notBefore)} – ${formatDay(locale, item.notAfter)}`}
            </Detail>
            <dt className="text-sm text-text-muted">{t('cert.field.fingerprint')}</dt>
            <dd className="m-0 flex min-w-0 items-start gap-2">
              <span className="min-w-0 flex-1 break-all text-md tabular-nums">{groupHex(item.fingerprintSha256)}</span>
              <IconButton size="sm" icon={Copy} label={t('cert.copyFingerprint')} onClick={copy} />
            </dd>
          </dl>
          <p className="m-0 text-sm text-text-muted">{t('cert.stored')}</p>
          <div>
            <Button variant="secondary" size="sm" onClick={() => void exportCertificate(item.id)}>
              {t('cert.export')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The Certificates tab of the Signatures dialog (DESIGN 3.8 S2): the signing identities kept in the keychain, with Create and
 * Import as forms that replace the list. The trusted-signers list is not placed here by the design and is not shown.
 */
export function CertificatesTab({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { status, items, loaded, error, selectedId } = useCertificates();
  const [view, setView] = useState<View>('list');
  const [ticket, setTicket] = useState<IdentityImportTicket | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    void refreshCertificates();
  }, []);

  const backToList = (focus?: string) => {
    setView('list');
    setTicket(null);
    if (focus !== undefined) focusDetails(focus);
    else focusAction(view === 'import' ? 'import' : 'create');
  };

  // Esc closes a form first (back to the list), then the dialog.
  useEffect(() => {
    if (view === 'list') return;
    return registerDismissLayer(DISMISS_PRIORITY.modal, () => backToList());
  });

  const keychainMissing = status === 'unavailable' || status === 'locked';
  const full = items.length >= IDENTITIES_MAX;
  const addable = canAdd(status, items.length);

  const pick = () => {
    setPickError(null);
    pickIdentityFile().then(
      (picked) => {
        if (picked === null) return;
        setTicket(picked);
        setView('import');
      },
      (caught: unknown) => setPickError(certErrorText(t, toAppError(caught))),
    );
  };

  const afterAdd = (info: SigningIdentityInfo, created: boolean) => {
    if (!created) addImported(info);
    setView('list');
    setTicket(null);
    announce(t('cert.created', { name: info.subject.commonName }));
    focusDetails(info.id);
  };

  const remove = (item: SigningIdentityInfo) => {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    const next = items[index + 1] ?? items[index - 1];
    void removeCertificate(item.id).then(() => {
      if (next !== undefined) focusDetails(next.id);
      else focusAction('create');
    });
  };

  if (view === 'create') {
    return <CreateForm onBack={() => backToList()} onCreated={(info) => afterAdd(info, true)} />;
  }
  if (view === 'import' && ticket !== null) {
    return <ImportForm ticket={ticket} onBack={() => backToList()} onImported={(info) => afterAdd(info, false)} />;
  }

  const empty = loaded && items.length === 0;
  const shownError = pickError ?? (error === null ? null : certErrorText(t, error));

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {keychainMissing && (
          <p
            role="status"
            className="m-0 flex min-h-control-lg items-center gap-2 rounded-button bg-subtle px-3 text-sm text-text"
          >
            <Icon icon={Info} size={16} className="shrink-0" />
            {t('cert.keychainMissing')}
          </p>
        )}
        {shownError !== null && (
          <p role="alert" className="m-0 text-sm text-error-text">
            {shownError}
          </p>
        )}
        {empty ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Icon icon={KeyRound} size={24} className="text-text-muted" />
            <p className="m-0 font-display text-xl">{t('cert.empty')}</p>
            <p className="m-0 text-sm text-text-muted">{t('cert.emptyHint')}</p>
          </div>
        ) : (
          <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
            {items.map((item) => (
              <CertRow key={item.id} item={item} selected={item.id === selectedId} onDelete={remove} />
            ))}
          </ul>
        )}
        {full && <p className="m-0 text-sm text-text-muted">{t('cert.limit')}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          data-cert-action="create"
          disabled={!addable}
          focusableWhenDisabled
          onClick={() => setView('create')}
        >
          {t('cert.create')}
        </Button>
        <Button variant="secondary" data-cert-action="import" disabled={!addable} focusableWhenDisabled onClick={pick}>
          {t('cert.import')}
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose}>
          {t('lib.close')}
        </Button>
      </div>
    </>
  );
}
