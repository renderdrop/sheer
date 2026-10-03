import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Save } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
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

const cancel = (): void => useSave.getState().setPrompt(null);

function UnsavedModal({ docId }: { docId: number }) {
  const t = useT();
  const name = useDocuments((state) => state.byId[docId]?.displayName ?? '');
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
    return registerDismissLayer(DISMISS_PRIORITY.modal, cancel);
  }, [present]);

  const save = (): void => {
    cancel();
    void saveNow(docId).then((saved) => {
      if (saved) forceCloseTab(docId);
    });
  };
  const discard = (): void => {
    cancel();
    forceCloseTab(docId);
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
        aria-labelledby="save-title"
        aria-describedby="save-body"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="surface-dialog flex w-dialog max-w-full flex-col rounded-card p-3 text-text outline-none"
      >
        <div className="flex items-center gap-1">
          <span className="flex size-control-md shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon">
            <Icon icon={Save} />
          </span>
          <h2 id="save-title" className="m-0 font-display text-xl">
            {t('save.title', { name })}
          </h2>
        </div>
        <p id="save-body" className="m-0 mt-1 text-text-muted">
          {t('save.body')}
        </p>
        <div className="mt-3 flex items-center gap-1">
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
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * The dialog that asks before a tab with changes that are not saved is closed (DESIGN 3.27): Don't Save, Cancel, Save. Initial focus
 * is Save, Esc and the backdrop cancel. Mounted once with the shell; `closeTab` opens it through `useSave`.
 */
export function UnsavedDialog() {
  const prompt = useSave((state) => state.prompt);
  return createPortal(
    <AnimatePresence>{prompt !== null && <UnsavedModal key={prompt} docId={prompt} />}</AnimatePresence>,
    document.body,
  );
}
