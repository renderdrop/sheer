import { motion, useIsPresent } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { cycleTab } from '../../components/focusTrap';
import { DURATION, useFade, usePopoverMotion } from '../../components/motion';

const APP_ROOT_ID = 'root';

export interface ModalProps {
  /** Id of the heading that names the dialog. */
  labelledBy: string;
  /** Tailwind width class from the tokens: `w-sheet` or `w-dialog-md`. */
  width: 'w-sheet' | 'w-dialog-md';
  /** Esc and a press on the backdrop. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * The dialog shell of DESIGN 3.19 for the job dialogs: backdrop, solid surface, focus trap, inert app behind it, Esc, and focus back
 * to where it was. It is rendered inside an `AnimatePresence`, which keeps it until its exit has played. The first element with
 * `data-autofocus` takes focus.
 */
export function Modal({ labelledBy, width, onClose, children }: ModalProps) {
  const present = useIsPresent();
  const dialog = useRef<HTMLDivElement>(null);
  const backdropMotion = useFade(DURATION.base, DURATION.fast);
  const dialogMotion = usePopoverMotion();
  const previousFocus = useRef<Element | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

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
    const unregister = registerDismissLayer(DISMISS_PRIORITY.modal, () => close.current());
    return () => {
      unregister();
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => cycleTab(event, event.currentTarget);

  return createPortal(
    <motion.div
      {...backdropMotion}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={`fixed inset-0 z-modal grid place-items-center bg-backdrop p-2 ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...dialogMotion}
        ref={dialog}
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`surface-dialog flex ${width} max-w-full flex-col rounded-card p-3 text-text outline-none`}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** Tile and title of a dialog (DESIGN 3.19): a 32 accent tile with the icon, then the heading. */
export function ModalHeader({ id, icon, title }: { id: string; icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="flex size-control-md shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon">
        {icon}
      </span>
      <h2 id={id} className="m-0 font-display text-xl">
        {title}
      </h2>
    </div>
  );
}
