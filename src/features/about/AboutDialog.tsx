import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { Button, Tooltip } from '../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { cycleTab } from '../../components/focusTrap';
import { DURATION, useFade, usePopoverMotion } from '../../components/motion';
import { APP_NAME } from '../../config/app';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import logoUrl from '../../../assets/brand/logo.svg';
import { AboutUpdate } from '../update/AboutUpdate';
import { useAboutDialog } from './state';

const close = (): void => useAboutDialog.getState().setOpen(false);

/** The app's root element: while the dialog is open the whole app behind it is inert (no focus, no pointer, hidden from assistive technology). */
const APP_ROOT_ID = 'root';

function AboutModal() {
  const t = useT();
  const version = useSettings((state) => state.version);
  const present = useIsPresent();
  const dialog = useRef<HTMLDivElement>(null);
  const backdropMotion = useFade(DURATION.base, DURATION.fast);
  const dialogMotion = usePopoverMotion();

  // Modal: focus goes to Close and the app behind is inert, until the exit starts.
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

  // On close focus returns to where it was (the More button the command was chosen from, or the canvas when its key was
  // typed). It has to be a passive effect, which runs after the commit: React puts focus back on the element that had it
  // before a commit, and while the dialog fades out that is still Close, so a layout effect's move would be undone.
  useEffect(() => {
    if (!present) return;
    return () => {
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present]);

  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.modal, close);
  }, [present]);

  // Tab and Shift+Tab cycle inside the dialog: nothing else is reachable while it is open.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => cycleTab(event, event.currentTarget);

  const soon = t('about.licensesSoon');

  return (
    <motion.div
      {...backdropMotion}
      onPointerDown={(event) => {
        // A press on the backdrop itself (not one that began in the dialog and ended here) dismisses.
        if (event.target === event.currentTarget) close();
      }}
      className={`fixed inset-0 z-modal grid place-items-center bg-backdrop p-2 ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...dialogMotion}
        ref={dialog}
        role="dialog"
        // Modal until the exit starts, as for focus and the inert app: from then on commands (`runAction`) run again.
        aria-modal={present ? 'true' : undefined}
        aria-label={t('about.title', { app: APP_NAME })}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="surface-dialog flex w-popover-max max-w-full flex-col items-center gap-2 rounded-card p-3 text-center text-text outline-none"
      >
        <img src={logoUrl} alt="" draggable={false} className="size-8 shrink-0" />
        <div className="flex flex-col items-center">
          <h2 className="m-0 font-display text-xl">{APP_NAME}</h2>
          {version !== null && <p className="m-0 text-sm text-text-muted">{t('about.version', { version })}</p>}
        </div>
        <p className="m-0 text-md">{t('about.license')}</p>
        <p className="m-0 text-sm text-text-muted">{t('about.privacy')}</p>
        <div className="flex w-full flex-col items-center gap-1">
          <AboutUpdate />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-1">
          {/* A placeholder until the licence notices ship with the app (ADR-010, item 8): focusable and announced, but it does nothing. */}
          <Tooltip label={soon}>
            <Button variant="secondary" disabled focusableWhenDisabled aria-description={soon}>
              {t('about.licenses')}
            </Button>
          </Tooltip>
          <Button variant="primary" data-autofocus="" onClick={close}>
            {t('about.close')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * The About dialog (DESIGN 3.13): a modal on a solid surface with `--shadow-3` at `--z-modal`, over a backdrop. Logo, name and
 * version, the licence, the privacy promise and the (not yet working) third-party licences entry. Focus is trapped, Esc, the
 * Close button and a press on the backdrop close it, and focus goes back to where it was. Mounted once, with the toolbar; the
 * `about` action opens it through `useAboutDialog`.
 */
export function AboutDialog() {
  const open = useAboutDialog((state) => state.open);
  return createPortal(<AnimatePresence>{open && <AboutModal key="about" />}</AnimatePresence>, document.body);
}
