import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Copy } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { setSignerTrust, listTrustedSigners, removeTrustedSigner, validateSignatures } from '../../api/signing';
import type { SignatureInfo, TrustedSigner } from '../../api/signing';
import { Button, Icon, IconButton } from '../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { cycleTab } from '../../components/focusTrap';
import { DURATION, useFade, usePopoverMotion } from '../../components/motion';
import { APP_NAME } from '../../config/app';
import { useLocale, useT } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { makeEditableCopy, showOnPage, viewSignedVersion } from './actions';
import { useLocal } from './hooks';
import { closeSignaturesDialog } from './open';
import { STATE_ICON } from './SigBanner';
import { checkSignatures, useSigcheck } from './store';
import { clean, isBad, laterKeys, signerName, stateOf, type SigState } from './summary';

/** The app's root element: inert while the dialog is open. */
const APP_ROOT_ID = 'root';

/** "2026-10-05T14:05:00+02:00" as the locale's date and time, then the offset the signer wrote. */
export function formatClaimed(iso: string, locale: string): string {
  const date = new Date(iso);
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? '';
  if (Number.isNaN(date.getTime())) return clean(iso);
  const text = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  return offset === '' ? text : `${text} ${offset === 'Z' ? 'UTC' : offset}`;
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {label !== undefined && <span className="t-caption text-text-muted">{label}</span>}
      <span className="t-body min-w-0 break-words">{children}</span>
    </div>
  );
}

function useStateWord() {
  const t = useT();
  return (state: SigState): string =>
    state === 'intact'
      ? t('sigs.state.intact')
      : state === 'later'
        ? t('sigs.state.later')
        : state === 'changed'
          ? t('sigs.state.changed')
          : t('sigs.state.unknown');
}

interface CardProps {
  docId: number;
  sig: SignatureInfo;
  total: number;
  onTrust: (sig: SignatureInfo, trusted: boolean) => void;
  busy: boolean;
}

/** One signature (DESIGN v1.4 S6): state icon and word, signer, claimed time, coverage, later changes, certificate, actions. */
function SignatureCard({ docId, sig, total, onTrust, busy }: CardProps) {
  const t = useT();
  const locale = useLocale();
  const local = useLocal();
  const word = useStateWord();
  const state = stateOf(sig);
  const bad = isBad(state);
  const broken = sig.cryptographic !== 'valid' && sig.cryptographic !== 'invalid';
  const later = laterKeys(sig);
  const cert = sig.signer;
  const errorText =
    sig.cryptographic === 'malformed'
      ? t('sigs.error.damaged')
      : sig.cryptographic === 'unsupportedAlgorithm'
        ? t('sigs.error.method', { app: APP_NAME })
        : sig.cryptographic === 'unverifiable'
          ? t('sigs.error.limits')
          : null;
  const expired =
    cert !== null &&
    sig.claimedTime !== null &&
    (new Date(sig.claimedTime) < new Date(cert.notBefore) || new Date(sig.claimedTime) > new Date(cert.notAfter));
  const canView = sig.coverage.type === 'earlierRevision' || state !== 'intact';
  const widget = sig.widget;
  const locks = sig.kind.type === 'certification' && sig.kind.p !== 3;

  return (
    <li
      data-sig-card={sig.index}
      data-state={state}
      className="border border-border-subtle bg-white flex flex-col gap-3 rounded-md p-4"
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 ${bad ? 'text-danger' : 'text-text'}`}>
          <Icon icon={STATE_ICON[state]} size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="t-caption text-text-muted">{t('sigs.number', { n: sig.index + 1, total })}</span>
          <span className="t-title truncate">{signerName(sig)}</span>
        </div>
        <span className={`t-label shrink-0 font-semibold ${bad ? 'text-danger' : ''}`}>{word(state)}</span>
      </div>

      {sig.claimedTime !== null && <Row label={t('sigs.signedAt')}>{formatClaimed(sig.claimedTime, locale)}</Row>}

      {errorText !== null && broken ? (
        <Row>{errorText}</Row>
      ) : (
        <Row>
          <span className={bad ? 'font-semibold' : ''}>{word(state)}</span>
          {sig.coverage.type === 'earlierRevision'
            ? `. ${t('sigs.covers', { n: sig.coverage.revision, total: sig.coverage.revision + 1 })}`
            : `. ${local.wholeFile}`}
        </Row>
      )}

      {later.length > 0 && (
        <Row label={local.later}>
          <ul className="m-0 list-disc ps-4">
            {later.map((key) => (
              <li key={key}>{local[`later.${key}`]}</li>
            ))}
          </ul>
        </Row>
      )}

      {cert !== null && (
        <>
          <Row label={t('cert.field.issuer')}>
            {clean(cert.issuer.commonName)}
            {cert.issuer.organization !== null && ` · ${clean(cert.issuer.organization)}`}
          </Row>
          <Row label={t('cert.field.validity')}>
            {formatClaimed(cert.notBefore, locale)} – {formatClaimed(cert.notAfter, locale)}
            {expired && <span className="block text-danger">{t('sigs.certExpiredAtSigning')}</span>}
          </Row>
          <Row label={t('cert.field.fingerprint')}>
            <span className="flex items-start gap-1">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{cert.fingerprintSha256}</code>
              <IconButton
                label={t('cert.copyFingerprint')}
                icon={Copy}
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(cert.fingerprintSha256).catch(() => undefined)}
              />
            </span>
          </Row>
          <p className="t-body m-0">
            {sig.trust === 'ownIdentity'
              ? local.own
              : sig.trust === 'trustedByYou'
                ? local.trusted
                : t('sigs.identity')}
          </p>
        </>
      )}

      {sig.reason !== null && sig.reason !== '' && (
        <Row label="">{t('seal.reason', { reason: clean(sig.reason) })}</Row>
      )}
      {sig.location !== null && sig.location !== '' && (
        <Row label="">{t('seal.location', { location: clean(sig.location) })}</Row>
      )}
      {locks && <Row label="">{t('sigs.locks')}</Row>}

      <div className="flex flex-wrap items-center gap-2">
        {widget !== null ? (
          <Button variant="ghost" size="sm" onClick={() => showOnPage(docId, sig.index, widget)}>
            {t('sigs.showOnPage')}
          </Button>
        ) : (
          <span className="t-caption text-text-muted">{t('sigs.invisible')}</span>
        )}
        {canView && !broken && (
          <Button variant="ghost" size="sm" onClick={() => void viewSignedVersion(docId, sig.index)}>
            {local.viewSigned}
          </Button>
        )}
        {cert !== null && sig.trust !== 'ownIdentity' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            focusableWhenDisabled
            onClick={() => onTrust(sig, sig.trust !== 'trustedByYou')}
          >
            {sig.trust === 'trustedByYou' ? local.untrust : local.trust}
          </Button>
        )}
      </div>
    </li>
  );
}

function Modal({ docId, index }: { docId: number; index: number | null }) {
  const t = useT();
  const local = useLocal();
  const present = useIsPresent();
  const dialog = useRef<HTMLDivElement>(null);
  const backdropMotion = useFade(DURATION.base, DURATION.fast);
  const dialogMotion = usePopoverMotion();
  const entry = useSigcheck((state) => state.byDoc[docId]);
  const locked = useDocuments((state) => state.byId[docId]?.signatureLock === 'locked');
  const [pins, setPins] = useState<TrustedSigner[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void checkSignatures(docId);
  }, [docId]);

  const refreshPins = () => {
    listTrustedSigners().then(setPins, () => undefined);
  };
  useEffect(refreshPins, []);

  const previousFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!present || element === null) return;
    if (!element.contains(document.activeElement)) previousFocus.current = document.activeElement;
    const root = document.getElementById(APP_ROOT_ID);
    root?.setAttribute('inert', '');
    element.focus({ preventScroll: true });
    return () => root?.removeAttribute('inert');
  }, [present]);
  useEffect(() => {
    if (!present) return;
    return () => {
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present]);
  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.modal, closeSignaturesDialog);
  }, [present]);

  // The card of the signature that was asked for scrolls into view once the report is there.
  const ready = entry?.status === 'ready';
  useEffect(() => {
    if (!ready || index === null) return;
    dialog.current?.querySelector<HTMLElement>(`[data-sig-card="${index}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [ready, index]);

  const sigs = useMemo(() => (entry?.status === 'ready' ? entry.report.signatures : []), [entry]);
  const truncated = entry?.status === 'ready' && entry.report.truncated;

  const onTrust = (sig: SignatureInfo, trusted: boolean) => {
    setBusy(true);
    setSignerTrust(docId, sig.index, trusted)
      .then((report) => useSigcheck.getState().setReport(docId, report))
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        refreshPins();
      });
  };
  const onRemovePin = (pin: TrustedSigner) => {
    setBusy(true);
    removeTrustedSigner(pin.fingerprint)
      .then(() => validateSignatures(docId))
      .then((report) => useSigcheck.getState().setReport(docId, report))
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        refreshPins();
      });
  };

  return (
    <motion.div
      {...backdropMotion}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeSignaturesDialog();
      }}
      className={`fixed inset-0 z-modal grid place-items-center bg-backdrop p-4 ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...dialogMotion}
        ref={dialog}
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-labelledby="sigs-title"
        aria-busy={entry?.status === 'checking' || entry === undefined ? true : undefined}
        tabIndex={-1}
        onKeyDown={(event) => cycleTab(event, event.currentTarget)}
        className="bg-panel border border-border-subtle shadow-floating flex max-h-full w-sheet max-w-full flex-col gap-4 rounded-card p-6 text-text outline-none"
      >
        <h2 id="sigs-title" className="m-0 shrink-0 font-display text-xl">
          {t('sigs.title')}
        </h2>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-sig-body="">
          {(entry === undefined || entry.status === 'checking') && (
            <div role="status" className="text-text-muted">
              {t('sigs.checking')}
            </div>
          )}
          {entry?.status === 'failed' && (
            <div role="alert" className="flex items-center gap-2 text-danger">
              <Icon icon={STATE_ICON.unknown} size={20} />
              <span className="font-semibold">{t('sigs.state.unknown')}</span>
            </div>
          )}
          {entry?.status === 'ready' && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {sigs.map((sig) => (
                <SignatureCard
                  key={sig.index}
                  docId={docId}
                  sig={sig}
                  total={sigs.length}
                  onTrust={onTrust}
                  busy={busy}
                />
              ))}
            </ul>
          )}
          {truncated && <p className="t-caption m-0 text-text-muted">{t('sigs.error.limits')}</p>}
          {pins.length > 0 && (
            <section aria-labelledby="sigs-pins" className="flex flex-col gap-1">
              <h3 id="sigs-pins" className="t-label m-0">
                {local.trustedList}
              </h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {pins.map((pin) => (
                  <li key={pin.fingerprint} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{clean(pin.commonName)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      focusableWhenDisabled
                      onClick={() => onRemovePin(pin)}
                    >
                      {local.removePin}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {locked && (
            <Button variant="ghost" onClick={() => void makeEditableCopy(docId)}>
              {t('cert.editableCopy')}
            </Button>
          )}
          <Button variant="secondary" data-autofocus="" onClick={closeSignaturesDialog}>
            {t('lib.close')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The Signatures dialog (DESIGN v1.4 S6). Mounted once with the shell; `openSignaturesDialog` opens it. */
export function SignaturesDialog() {
  const dialog = useSigcheck((state) => state.dialog);
  return createPortal(
    <AnimatePresence>
      {dialog !== null && <Modal key="signatures" docId={dialog.docId} index={dialog.index} />}
    </AnimatePresence>,
    document.body,
  );
}
