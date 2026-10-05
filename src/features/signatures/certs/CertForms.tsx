import { ArrowLeft, Eye, EyeOff, FileKey } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import type { AppError } from '../../../api/errors';
import { toAppError } from '../../../api/errors';
import {
  IDENTITY_EMAIL_MAX,
  IDENTITY_NAME_MAX,
  IDENTITY_ORG_MAX,
  discardIdentityImport,
  fitsNewIdentity,
  importSigningIdentity,
  type IdentityImportTicket,
  type SigningIdentityInfo,
} from '../../../api/signing';
import { Button, Field, Icon, IconButton } from '../../../components';
import { useT } from '../../../i18n';
import { certErrorText, emailOk } from './model';
import { createCertificate } from './state';

/** The wait before a running action shows its "…ing" label (DESIGN 3.8 S2, `--saving-delay`). */
const SAVING_DELAY_MS = 200;

function useAfterDelay(on: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setLate(true), SAVING_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [on]);
  return late;
}

function Back({ onClick, title }: { onClick: () => void; title?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <IconButton size="sm" icon={ArrowLeft} label={t('copy.back')} onClick={onClick} className="self-start" />
      {title !== undefined && <h3 className="t-title m-0">{title}</h3>}
    </div>
  );
}

interface FormProps {
  onBack: () => void;
}

/** Create (DESIGN 3.8 S2): name 1 to 64, email and organisation optional; the key is made in Rust and stays in the keychain. */
export function CreateForm({ onBack, onCreated }: FormProps & { onCreated: (info: SigningIdentityInfo) => void }) {
  const t = useT();
  const ids = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [emailError, setEmailError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const label = useAfterDelay(busy);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameField.current?.focus({ preventScroll: true });
  }, []);

  const valid = fitsNewIdentity({
    name,
    email: email.trim() === '' ? null : email.trim(),
    organization: org.trim() === '' ? null : org.trim(),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !valid) return;
    if (!emailOk(email)) {
      setEmailError(true);
      return;
    }
    setBusy(true);
    setError(null);
    createCertificate({
      name: name.trim(),
      email: email.trim() === '' ? null : email.trim(),
      organization: org.trim() === '' ? null : org.trim(),
    }).then(
      (info) => onCreated(info),
      (caught: unknown) => {
        setError(toAppError(caught));
        setBusy(false);
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Back onClick={onBack} title={t('cert.createTitle')} />
        <label className="flex flex-col gap-1 text-sm text-text-muted" htmlFor={`${ids}-name`}>
          {t('cert.name')}
        </label>
        <Field
          ref={nameField}
          id={`${ids}-name`}
          autoComplete="off"
          spellCheck={false}
          maxLength={IDENTITY_NAME_MAX}
          required
          disabled={busy}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full"
        />
        <label className="flex flex-col gap-1 text-sm text-text-muted" htmlFor={`${ids}-email`}>
          {t('cert.email')}
        </label>
        <Field
          id={`${ids}-email`}
          type="email"
          autoComplete="off"
          spellCheck={false}
          maxLength={IDENTITY_EMAIL_MAX}
          disabled={busy}
          value={email}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? `${ids}-email-error` : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            if (emailError && emailOk(event.target.value)) setEmailError(false);
          }}
          onBlur={() => setEmailError(!emailOk(email))}
          className="w-full aria-invalid:border-error-text"
        />
        {emailError && (
          <p id={`${ids}-email-error`} role="alert" className="m-0 text-sm text-error-text">
            {t('cert.errEmail')}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm text-text-muted" htmlFor={`${ids}-org`}>
          {t('cert.org')}
        </label>
        <Field
          id={`${ids}-org`}
          autoComplete="off"
          spellCheck={false}
          maxLength={IDENTITY_ORG_MAX}
          disabled={busy}
          value={org}
          onChange={(event) => setOrg(event.target.value)}
          className="w-full"
        />
        <p className="m-0 text-sm text-text-muted">{t('cert.createNote')}</p>
        {error !== null && (
          <p role="alert" className="m-0 text-sm text-error-text">
            {certErrorText(t, error)}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          {t('sign.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!valid || busy} focusableWhenDisabled>
          {label ? t('cert.creating') : t('sign.create')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Import (DESIGN 3.8 S2): the file was picked by the Rust dialog, so only its name is known here. The password goes to
 * `importSigningIdentity` once per try and is dropped from the state as soon as the answer is in.
 */
export function ImportForm({
  ticket,
  onBack,
  onImported,
}: FormProps & { ticket: IdentityImportTicket; onImported: (info: SigningIdentityInfo) => void }) {
  const t = useT();
  const ids = useId();
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [dead, setDead] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const unmounted = useRef(false);

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);

  // A file that was picked and not imported is dropped when the form goes away. StrictMode runs the cleanup once without a real
  // unmount, so the drop waits a tick and only happens if the form did not come back.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      setTimeout(() => {
        if (unmounted.current && !finished.current) {
          finished.current = true;
          discardIdentityImport(ticket.ticket).catch(() => undefined);
        }
      }, 0);
    };
  }, [ticket.ticket]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || dead) return;
    setBusy(true);
    setError(null);
    importSigningIdentity(ticket.ticket, password).then(
      (info) => {
        finished.current = true;
        setPassword('');
        onImported(info);
      },
      (caught: unknown) => {
        const failure = toAppError(caught);
        setError(failure);
        setBusy(false);
        setPassword('');
        if (failure.code === 'password_required') {
          requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
        } else if (failure.code !== 'keychain_unavailable') {
          // The backend dropped the file: another password would not help.
          setDead(true);
        }
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Back onClick={onBack} />
        <p className="m-0 flex min-w-0 items-center gap-2 text-md font-semibold">
          <Icon icon={FileKey} size={20} className="shrink-0" />
          <span className="truncate">{ticket.displayName}</span>
        </p>
        <label className="text-sm text-text-muted" htmlFor={`${ids}-password`}>
          {t('cert.password')}
        </label>
        <div className="flex items-center gap-2">
          <Field
            ref={field}
            id={`${ids}-password`}
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || dead}
            value={password}
            aria-invalid={error !== null ? true : undefined}
            aria-describedby={error !== null ? `${ids}-error` : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="min-w-0 flex-1 aria-invalid:border-error-text"
          />
          <IconButton
            size="sm"
            icon={shown ? EyeOff : Eye}
            label={shown ? t('cert.hide') : t('cert.show')}
            onClick={() => setShown((value) => !value)}
          />
        </div>
        {error !== null && (
          <p id={`${ids}-error`} role="alert" className="m-0 text-sm text-error-text">
            {certErrorText(t, error)}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          {t('sign.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || dead} focusableWhenDisabled>
          {t('cert.importDo')}
        </Button>
      </div>
    </form>
  );
}
