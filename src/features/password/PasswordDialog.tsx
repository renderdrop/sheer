import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { CircleAlert, Eye, EyeOff, LoaderCircle, Lock } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { MAX_PASSWORD_BYTES, closeDocument, unlockDocument } from '../../api/documents';
import { toAppError } from '../../api/errors';
import { Button, Field, Icon, IconButton } from '../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { cycleTab } from '../../components/focusTrap';
import { DURATION, useFade, usePopoverMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { usePassword, type PasswordRequest } from './state';

const APP_ROOT_ID = 'root';

/** UTF-8 length, the unit of the backend limit. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function PasswordModal({ request }: { request: PasswordRequest }) {
  const t = useT();
  const present = useIsPresent();
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const backdropMotion = useFade(DURATION.base, DURATION.fast);
  const dialogMotion = usePopoverMotion();
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState(false);
  const gone = useRef(false);

  const cancel = () => {
    if (gone.current) return;
    gone.current = true;
    setPassword('');
    usePassword.getState().finish(request.id);
    // The backend forgets the document that waited for its password.
    closeDocument(request.id).catch(() => undefined);
  };

  const previousFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!present || element === null) return;
    if (!element.contains(document.activeElement)) previousFocus.current = document.activeElement;
    const root = document.getElementById(APP_ROOT_ID);
    root?.setAttribute('inert', '');
    field.current?.focus({ preventScroll: true });
    return () => root?.removeAttribute('inert');
  }, [present]);

  useEffect(() => {
    if (!present) return;
    return () => {
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present]);

  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  });
  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.modal, () => cancelRef.current());
  }, [present]);

  const empty = password === '';
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (empty || checking || byteLength(password) > MAX_PASSWORD_BYTES) return;
    setChecking(true);
    setWrong(false);
    unlockDocument(request.id, password).then(
      (document) => {
        gone.current = true;
        setPassword('');
        usePassword.getState().finish(request.id);
        adoptOpenOutcomes([{ type: 'opened', document }]);
      },
      (caught: unknown) => {
        const error = toAppError(caught);
        if (error.code === 'password_required') {
          setChecking(false);
          setWrong(true);
          requestAnimationFrame(() => field.current?.select());
          return;
        }
        // Corrupt, changed or unsupported: the backend forgot the document; the banner explains.
        gone.current = true;
        setPassword('');
        usePassword.getState().finish(request.id);
        useUi.getState().showBanner(error);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => cycleTab(event, event.currentTarget);

  return (
    <motion.div
      {...backdropMotion}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
      className={`fixed inset-0 z-modal grid place-items-center bg-backdrop p-2 ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...dialogMotion}
        ref={dialog}
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-labelledby="password-title"
        aria-describedby="password-body"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="surface-dialog flex w-dialog max-w-full flex-col rounded-card p-3 text-text outline-none"
      >
        <form onSubmit={submit} className="flex flex-col">
          <div className="flex items-center gap-1">
            <span className="flex size-control-md shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon">
              <Icon icon={Lock} />
            </span>
            <h2 id="password-title" className="m-0 font-display text-xl">
              {t('password.title')}
            </h2>
          </div>
          <p id="password-body" className="m-0 mt-1 text-text-muted">
            {t('password.body', { name: request.name })}
          </p>
          <label htmlFor="password-field" className="mt-2 text-sm font-semibold">
            {t('password.label')}
          </label>
          <div className="relative mt-0-5">
            <Field
              id="password-field"
              ref={field}
              type={shown ? 'text' : 'password'}
              value={password}
              readOnly={checking}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={wrong ? true : undefined}
              aria-describedby={wrong ? 'password-error' : undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setWrong(false);
              }}
              className="w-full! pe-4!"
            />
            <span className="absolute inset-y-0 end-0-5 flex items-center">
              <IconButton
                size="sm"
                label={t('password.show')}
                icon={shown ? EyeOff : Eye}
                variant="toggle"
                pressed={shown}
                onClick={() => setShown(!shown)}
              />
            </span>
          </div>
          <div className="mt-0-5 flex h-2 items-center text-sm text-error-text">
            {wrong && (
              <p id="password-error" role="alert" className="m-0 flex items-center gap-0-5">
                <Icon icon={CircleAlert} size={12} />
                {t('password.wrong')}
              </p>
            )}
          </div>
          <div className="mt-3 flex items-center justify-end gap-1">
            <Button variant="secondary" onClick={cancel}>
              {t('password.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={empty}
              focusableWhenDisabled
              aria-busy={checking ? true : undefined}
              aria-label={checking ? t('password.checking') : undefined}
            >
              {checking ? (
                <Icon icon={LoaderCircle} className="animate-spin motion-reduce:animate-none" />
              ) : (
                t('password.open')
              )}
            </Button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

/**
 * The password prompt (DESIGN 3.19): a modal on the About dialog surface for the first document that waits for its password
 * (`usePassword`). The password lives in the field for one attempt and is cleared when the dialog goes; Esc and Cancel close the
 * document in the backend. Mounted once with the toolbar.
 */
export function PasswordDialog() {
  const request = usePassword((state) => state.queue[0]);
  return createPortal(
    <AnimatePresence>{request !== undefined && <PasswordModal key={request.id} request={request} />}</AnimatePresence>,
    document.body,
  );
}
