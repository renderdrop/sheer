import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { FileWarning, Lock, Save, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button, Icon } from '../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { cycleTab } from '../../components/focusTrap';
import { DURATION, useFade, usePopoverMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { forceCloseTab } from '../tabs/nav';
import { saveNow } from './commands';
import { useSave } from './state';

/** The app's root element: while the dialog is open the whole app behind it is inert. */
const APP_ROOT_ID = 'root';

/** The close is cancelled: for a tab it stays open, for a quit the quit stops. */
const cancel = (): void => {
  const { answer } = useSave.getState();
  useSave.getState().setPrompt(null);
  answer?.('cancel');
};

const cancelOverwrite = (): void => {
  const { overwrite } = useSave.getState();
  useSave.getState().setOverwrite(null);
  overwrite?.resolve(false);
};

/** The modal frame of both dialogs (DESIGN 3.27, motion as About): inert app behind it, focus trap, Esc and backdrop cancel. */
function DialogShell({
  icon,
  title,
  body,
  onCancel,
  children,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const dialog = useRef<HTMLDivElement>(null);
  const backdropMotion = useFade(DURATION.base, DURATION.fast);
  const dialogMotion = usePopoverMotion();

  const previousFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!present || element === null) return;
    if (!element.contains(document.activeElement)) previousFocus.current = document.activeElement;
    const root = document.getElementById(APP_ROOT_ID);
    root?.setAttribute('inert', '');
    (element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus({ preventScroll: true });
    return () => root?.removeAttribute('inert');
  }, [present]);

  useEffect(() => {
    if (!present) return;
    return () => {
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present]);

  // Esc cancels.
  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.modal, onCancel);
  }, [present, onCancel]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => cycleTab(event, event.currentTarget);

  return (
    <motion.div
      {...backdropMotion}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      className={`fixed inset-0 z-modal grid place-items-center bg-backdrop p-2 ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...dialogMotion}
        ref={dialog}
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-labelledby="save-title"
        aria-describedby="save-body"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="surface-dialog flex w-dialog max-w-full flex-col rounded-card p-3 text-text outline-none"
      >
        <div className="flex items-center gap-1">
          <span className="flex size-control-md shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon">
            <Icon icon={icon} />
          </span>
          <h2 id="save-title" className="m-0 font-display text-xl">
            {title}
          </h2>
        </div>
        <p id="save-body" className="m-0 mt-1 text-text-muted">
          {body}
        </p>
        <div className="mt-3 flex items-center gap-1">{children}</div>
      </motion.div>
    </motion.div>
  );
}

function UnsavedModal({ docId }: { docId: number }) {
  const t = useT();
  const name = useDocuments((state) => state.byId[docId]?.displayName ?? '');
  const quit = useSave((state) => state.quit);

  // A quit hears the answer and walks on; a closed tab acts at once.
  const save = (): void => {
    const { answer } = useSave.getState();
    useSave.getState().setPrompt(null);
    if (answer !== null) {
      answer('save');
      return;
    }
    void saveNow(docId).then((saved) => {
      if (saved) forceCloseTab(docId);
    });
  };
  const discard = (): void => {
    const { answer } = useSave.getState();
    useSave.getState().setPrompt(null);
    if (answer !== null) answer('discard');
    else forceCloseTab(docId);
  };

  const title = t('save.title', { name });
  return (
    <DialogShell
      icon={Save}
      title={quit !== null && quit.n > 1 ? `${title} ${t('save.count', { i: quit.i, n: quit.n })}` : title}
      body={t('save.body')}
      onCancel={cancel}
    >
      <Button variant="ghost" onClick={discard}>
        {t('save.discard')}
      </Button>
      <span className="flex-1" />
      <Button variant="secondary" onClick={cancel}>
        {t('save.cancel')}
      </Button>
      <Button variant="primary" data-autofocus="" onClick={save}>
        {t('save.save')}
      </Button>
    </DialogShell>
  );
}

/** The file changed on disk since it was opened: replace it, or leave it as it is. Focus starts on Cancel (the safe choice). */
function OverwriteModal({ docId, resolve }: { docId: number; resolve: (confirmed: boolean) => void }) {
  const t = useT();
  const name = useDocuments((state) => state.byId[docId]?.displayName ?? '');
  const overwrite = (): void => {
    useSave.getState().setOverwrite(null);
    resolve(true);
  };
  return (
    <DialogShell
      icon={FileWarning}
      title={t('save.overwriteTitle', { name })}
      body={t('save.overwriteBody')}
      onCancel={cancelOverwrite}
    >
      <span className="flex-1" />
      <Button variant="secondary" data-autofocus="" onClick={cancelOverwrite}>
        {t('save.cancel')}
      </Button>
      <Button variant="primary" onClick={overwrite}>
        {t('save.overwrite')}
      </Button>
    </DialogShell>
  );
}

/** A save would rewrite a protected file in full (ADR-047): save, or leave it. Focus starts on Cancel. */
function RewriteModal({ docId, resolve }: { docId: number; resolve: (confirmed: boolean) => void }) {
  const t = useT();
  const name = useDocuments((state) => state.byId[docId]?.displayName ?? '');
  const answer = (confirmed: boolean): void => {
    useSave.getState().setRewrite(null);
    resolve(confirmed);
  };
  return (
    <DialogShell
      icon={Lock}
      title={t('save.rewriteTitle', { name })}
      body={t('error.needs_confirmation.rewriteEncrypted')}
      onCancel={() => answer(false)}
    >
      <span className="flex-1" />
      <Button variant="secondary" data-autofocus="" onClick={() => answer(false)}>
        {t('save.cancel')}
      </Button>
      <Button variant="primary" onClick={() => answer(true)}>
        {t('save.rewriteConfirm')}
      </Button>
    </DialogShell>
  );
}

/**
 * The dialogs of saving (DESIGN 3.27), mounted once with the shell. The first asks before a tab with changes that are not saved is
 * closed, or at each edited document while quitting: Don't Save, Cancel, Save; initial focus is Save, Esc and the backdrop cancel.
 * The second asks before a save replaces a file that changed on disk.
 */
export function UnsavedDialog() {
  const prompt = useSave((state) => state.prompt);
  const overwrite = useSave((state) => state.overwrite);
  const rewrite = useSave((state) => state.rewrite);
  return createPortal(
    <AnimatePresence>
      {prompt !== null && <UnsavedModal key={`unsaved-${prompt}`} docId={prompt} />}
      {overwrite !== null && (
        <OverwriteModal key={`overwrite-${overwrite.docId}`} docId={overwrite.docId} resolve={overwrite.resolve} />
      )}
      {rewrite !== null && (
        <RewriteModal key={`rewrite-${rewrite.docId}`} docId={rewrite.docId} resolve={rewrite.resolve} />
      )}
    </AnimatePresence>,
    document.body,
  );
}
