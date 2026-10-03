import { AnimatePresence } from 'motion/react';
import { CircleAlert, Eye, EyeOff, Info, Lock } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import type { ChangeSet } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import {
  PERMISSIONS,
  getProtection,
  stageProtection,
  stageUnprotection,
  type Permission,
  type ProtectionInfo,
} from '../../api/protection';
import { Button, Field, Icon, IconButton } from '../../components';
import { cx } from '../../components/cx';
import { APP_NAME } from '../../config/app';
import { useT } from '../../i18n';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { Modal, ModalHeader } from '../jobs/Modal';
import { MAX_PASSWORD_BYTES, byteLength, isRestricted, isValid, passwordStrength, validateProtect } from './rules';

/** A password field with its eye toggle (DESIGN 3.19): never prefilled, no autocomplete, no spellcheck. */
function PasswordField({
  id,
  label,
  value,
  shown,
  invalid,
  describedBy,
  autoFocus,
  onChange,
  onBlur,
  onToggle,
  toggleLabel,
}: {
  id: string;
  label: string;
  value: string;
  shown: boolean;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onToggle?: () => void;
  toggleLabel: string;
}) {
  return (
    <>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <div className="relative mt-0-5">
        <Field
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={autoFocus ? '' : undefined}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="w-full! pe-4!"
        />
        {onToggle !== undefined && (
          <span className="absolute inset-y-0 end-0-5 flex items-center">
            <IconButton
              size="sm"
              label={toggleLabel}
              icon={shown ? EyeOff : Eye}
              variant="toggle"
              pressed={shown}
              onClick={onToggle}
            />
          </span>
        )}
      </div>
    </>
  );
}

/** The 16 px slot under a field pair: the error is announced, the slot stays so nothing jumps. */
function ErrorSlot({ id, message }: { id: string; message: string | null }) {
  return (
    <div className="flex h-2 items-center text-sm text-error-text">
      {message !== null && (
        <p id={id} role="alert" className="m-0 flex items-center gap-0-5">
          <Icon icon={CircleAlert} size={12} />
          {message}
        </p>
      )}
    </div>
  );
}

function StrengthMeter({ password }: { password: string }) {
  const t = useT();
  const { level, word } = passwordStrength(password);
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('protect.strength')}>
      <div className="flex flex-1 gap-0-5" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={cx('h-0-5 flex-1 rounded-full', n <= level ? 'bg-accent' : 'bg-track')} />
        ))}
      </div>
      <span className="min-w-6 text-sm text-text-muted" aria-live="polite">
        {level === 0 ? '' : t(`protect.${word}`)}
      </span>
    </div>
  );
}

const PERMISSION_KEYS: Record<Permission, 'protect.print' | 'protect.copy' | 'protect.edit'> = {
  print: 'protect.print',
  copy: 'protect.copy',
  edit: 'protect.edit',
};

function ProtectModal({ docId }: { docId: number }) {
  const t = useT();
  const id = useId();
  const [info, setInfo] = useState<ProtectionInfo | null>(null);
  const [requireOpen, setRequireOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [shown, setShown] = useState(false);
  const [allow, setAllow] = useState<readonly Permission[]>(PERMISSIONS);
  const [permPassword, setPermPassword] = useState('');
  const [permConfirm, setPermConfirm] = useState('');
  const [blurred, setBlurred] = useState({ open: false, perm: false });
  const [revealRemove, setRevealRemove] = useState(false);
  const [removeShown, setRemoveShown] = useState(false);
  const [removePassword, setRemovePassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  /** Passwords leave component state here: on close, after a staged change, or when a password error needs retyping. */
  const clearSecrets = (): void => {
    setPassword('');
    setConfirm('');
    setPermPassword('');
    setPermConfirm('');
    setRemovePassword('');
    setShown(false);
    setRemoveShown(false);
  };
  const close = (): void => {
    clearSecrets();
    useUi.getState().setProtectOpen(false);
  };

  useEffect(() => {
    alive.current = true;
    getProtection(docId).then(
      (loaded) => {
        if (alive.current) setInfo(loaded);
      },
      () => undefined,
    );
    return () => {
      alive.current = false;
    };
  }, [docId]);

  const problems = validateProtect({ requireOpen, password, confirm, allow, permPassword, permConfirm });
  const valid = isValid(problems);
  const showOpenMismatch = blurred.open && problems.open === 'mismatch';
  const showPermMismatch = blurred.perm && problems.perm === 'mismatch';
  const openMessage =
    problems.open === 'length' ? t('protect.invalidLength') : showOpenMismatch ? t('protect.mismatch') : null;
  const permMessage = problems.same
    ? t('protect.same')
    : problems.perm === 'length'
      ? t('protect.invalidLength')
      : showPermMismatch
        ? t('protect.mismatch')
        : null;

  const stage = async (run: () => Promise<ChangeSet>): Promise<void> => {
    setBusy(true);
    try {
      const changes = await run();
      useAnnotations.getState().applyChanges(docId, changes);
      useUi.getState().showToast({ message: t('protect.staged') });
      close();
    } catch (caught) {
      const error = toAppError(caught);
      if (error.code === 'password_required') {
        setWrong(true);
        setRemovePassword('');
      } else useUi.getState().showBanner(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const apply = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!valid || busy) return;
    const opts = {
      openPassword: requireOpen ? password : null,
      permissionsPassword: isRestricted(allow) ? permPassword : null,
      allow,
    };
    void stage(() => stageProtection(docId, opts));
  };

  const remove = (): void => {
    if (busy || info === null) return;
    const needsPassword = !info.ownerRights;
    if (needsPassword && !revealRemove) {
      setRevealRemove(true);
      return;
    }
    if (needsPassword && (removePassword === '' || byteLength(removePassword) > MAX_PASSWORD_BYTES)) return;
    const secret = needsPassword ? removePassword : null;
    setWrong(false);
    void stage(() => stageUnprotection(docId, secret));
  };

  const toggle = (permission: Permission, on: boolean): void =>
    setAllow(PERMISSIONS.filter((p) => (p === permission ? on : allow.includes(p))));

  const titleId = `${id}-title`;
  const showStatus = info !== null && info.encrypted;
  return (
    <Modal labelledBy={titleId} width="w-dialog-md" onClose={close}>
      <ModalHeader id={titleId} icon={<Icon icon={Lock} />} title={t('protect.title')} />
      <form onSubmit={apply} className="mt-2 flex flex-col" noValidate>
        {showStatus && (
          <section className="mb-2 flex flex-col gap-1 border-b border-divider pb-2">
            <div className="flex items-center gap-1">
              <Icon icon={Lock} size={16} />
              <span className="flex-1">{t('protect.isProtected')}</span>
              {!revealRemove && (
                <Button size="sm" variant="secondary" onClick={remove}>
                  {t('protect.remove')}
                </Button>
              )}
            </div>
            {revealRemove && (
              <div className="flex flex-col">
                <PasswordField
                  id={`${id}-rm`}
                  label={t('protect.ownerPassword')}
                  value={removePassword}
                  shown={removeShown}
                  invalid={wrong}
                  describedBy={wrong ? `${id}-rm-err` : undefined}
                  autoFocus
                  onChange={(value) => {
                    setRemovePassword(value);
                    setWrong(false);
                  }}
                  onToggle={() => setRemoveShown(!removeShown)}
                  toggleLabel={removeShown ? t('protect.hide') : t('protect.show')}
                />
                <ErrorSlot id={`${id}-rm-err`} message={wrong ? t('protect.wrongPerm') : null} />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={removePassword === ''}
                    focusableWhenDisabled
                    onClick={remove}
                  >
                    {t('protect.remove')}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="flex flex-col">
          <label className="flex min-h-control-sm cursor-pointer items-center gap-1 text-md">
            <input
              type="checkbox"
              className="accent-accent"
              checked={requireOpen}
              data-autofocus=""
              onChange={(event) => setRequireOpen(event.target.checked)}
            />
            {t('protect.requireOpen')}
          </label>
          {requireOpen && (
            <div className="mt-1 flex flex-col">
              <PasswordField
                id={`${id}-pw`}
                label={t('protect.password')}
                value={password}
                shown={shown}
                invalid={problems.open === 'length'}
                onChange={setPassword}
                onToggle={() => setShown(!shown)}
                toggleLabel={shown ? t('protect.hide') : t('protect.show')}
              />
              <div className="mt-1 flex flex-col">
                <PasswordField
                  id={`${id}-pw2`}
                  label={t('protect.confirm')}
                  value={confirm}
                  shown={shown}
                  invalid={showOpenMismatch}
                  describedBy={openMessage !== null ? `${id}-open-err` : undefined}
                  onChange={setConfirm}
                  onBlur={() => setBlurred((b) => ({ ...b, open: true }))}
                  toggleLabel={t('protect.show')}
                />
              </div>
              <ErrorSlot id={`${id}-open-err`} message={openMessage} />
              <StrengthMeter password={password} />
            </div>
          )}
        </section>

        <section className="mt-2 flex flex-col border-t border-divider pt-2">
          {PERMISSIONS.map((permission) => (
            <label key={permission} className="flex min-h-control-sm cursor-pointer items-center gap-1 text-md">
              <input
                type="checkbox"
                className="accent-accent"
                checked={allow.includes(permission)}
                onChange={(event) => toggle(permission, event.target.checked)}
              />
              {t(PERMISSION_KEYS[permission])}
            </label>
          ))}
          {isRestricted(allow) && (
            <div className="mt-1 flex flex-col">
              <PasswordField
                id={`${id}-pp`}
                label={t('protect.permPassword')}
                value={permPassword}
                shown={shown}
                invalid={problems.same}
                onChange={setPermPassword}
                onToggle={requireOpen ? undefined : () => setShown(!shown)}
                toggleLabel={shown ? t('protect.hide') : t('protect.show')}
              />
              <div className="mt-1 flex flex-col">
                <PasswordField
                  id={`${id}-pp2`}
                  label={t('protect.permConfirm')}
                  value={permConfirm}
                  shown={shown}
                  invalid={showPermMismatch}
                  describedBy={permMessage !== null ? `${id}-perm-err` : undefined}
                  onChange={setPermConfirm}
                  onBlur={() => setBlurred((b) => ({ ...b, perm: true }))}
                  toggleLabel={t('protect.show')}
                />
              </div>
              <ErrorSlot id={`${id}-perm-err`} message={permMessage} />
            </div>
          )}
          <p className="m-0 mt-1 text-sm text-text-muted">{t('protect.permNote')}</p>
        </section>

        <p className="m-0 mt-2 flex items-center gap-0-5 text-sm text-text-muted">
          <Icon icon={Lock} size={12} />
          {t('protect.aes', { app: APP_NAME })}
        </p>
        <p className="m-0 mt-0-5 flex items-center gap-0-5 text-sm text-text-muted">
          <Icon icon={Info} size={12} />
          {t('protect.staged')}
        </p>

        <div className="mt-3 flex items-center justify-end gap-1">
          <Button variant="secondary" onClick={close}>
            {t('protect.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy} focusableWhenDisabled>
            {t('protect.apply')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The Protect sheet (DESIGN 3.39), open while `useUi.protectOpen`. Passwords live only in this component's state: cleared when the
 * sheet closes and when Apply is pressed, never logged, never stored. Apply stages the change (one undo step); the next save writes it.
 */
export function ProtectSheet() {
  const open = useUi((state) => state.protectOpen);
  const doc = useDocuments(selectActiveDocument);
  return <AnimatePresence>{open && doc !== null && <ProtectModal key={doc.id} docId={doc.id} />}</AnimatePresence>;
}
