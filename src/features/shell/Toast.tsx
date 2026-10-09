import { Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';

import { Button } from '../../components';
import { Icon } from '../../components/Icon';
import { TWEEN } from '../../components/motion';
import { useNoticeSlot } from '../../components/notices';
import { tokenPx } from '../../components/tokens';
import { useUi, type Toast } from '../../stores/ui';

/** How long a toast stays (DESIGN 3.12): 4 s, 8 s when it has an action. Hover, focus inside and blur pause and restart it. */
export const TOAST_MS = 4000;
export const TOAST_ACTION_MS = 8000;

/** The toast (DESIGN 4): White, border, radius md, floating, 40 high, Ink label, an optional Ghost action; the icon is Ink. */
function ToastView({ toast }: { toast: Toast }) {
  const { action } = toast;
  const reduce = useReducedMotion() === true;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lifetime = action === undefined ? TOAST_MS : TOAST_ACTION_MS;
  const arm = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => useUi.getState().dismissToast(toast.id), lifetime);
  }, [toast.id, lifetime]);
  const hold = useCallback(() => clearTimeout(timer.current), []);
  useEffect(() => {
    arm();
    return hold;
  }, [arm, hold]);
  return (
    <motion.div
      // The toast never takes focus; the persistent live region of the layer says it (a region added with its text is often missed).
      data-toast=""
      initial={{ opacity: 0, y: reduce ? 0 : tokenPx('--offset-enter', 8) }}
      animate={{ opacity: 1, y: 0, transition: TWEEN.slow }}
      exit={{ opacity: 0, transition: TWEEN.base }}
      onMouseEnter={hold}
      onMouseLeave={arm}
      onFocus={hold}
      onBlur={arm}
      className="bg-panel border border-border-subtle shadow-floating pointer-events-auto flex min-h-toast min-w-toast-min max-w-toast-max items-center gap-2 rounded-button px-3 py-2"
    >
      <Icon
        icon={toast.tone === 'error' ? CircleAlert : toast.tone === 'alert' ? TriangleAlert : Check}
        className={toast.tone === 'error' ? 'shrink-0 text-error-text' : 'shrink-0 text-text'}
      />
      <span className="min-w-0 flex-auto t-label">{toast.message}</span>
      {action !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            useUi.getState().dismissToast(toast.id);
            action.run();
          }}
        >
          {action.label}
        </Button>
      )}
    </motion.div>
  );
}

/**
 * The toast slot: the bottom centre of the window, 12 above the status bar (never over it), at `--z-toast`. The layer takes no pointer itself, so
 * it never covers what is under it; one toast at a time.
 */
export function ToastLayer() {
  const toast = useUi((state) => state.toast);
  // One notice at a time (DESIGN 3.9 Q8): an error toast takes the slot at once, any other waits behind it and the coach mark.
  const shown = useNoticeSlot(`toast-${toast?.id ?? 0}`, toast?.tone === 'error' ? 'error' : 'info', toast !== null);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--statusbar-height)+var(--space-3))] z-toast flex justify-center">
      {/* An error is said at once (assertive, role alert); anything else politely. */}
      <div role="status" className="sr-only">
        {toast?.tone === 'error' ? null : toast?.message}
      </div>
      {toast?.tone === 'error' && (
        <div role="alert" className="sr-only">
          {toast.message}
        </div>
      )}
      {/* "wait": a toast that replaces another does not sit beside the one still fading out (a doubled copy in the flex row). */}
      <AnimatePresence initial={false} mode="wait">
        {toast !== null && shown && <ToastView key={toast.id} toast={toast} />}
      </AnimatePresence>
    </div>
  );
}
