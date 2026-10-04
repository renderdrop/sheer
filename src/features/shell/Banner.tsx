import { CircleAlert, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useState } from 'react';

import { IconButton } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { errorText, useT } from '../../i18n';
import { APP_NAME } from '../../config/app';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import type { AppError } from '../../api/errors';

export interface BannerProps {
  error: AppError;
  onDismiss: () => void;
}

/**
 * The banner row (DESIGN 3.12): G1, at least 48 high, radius 16, padding 8 8 8 16. An error is persistent until it is
 * dismissed or resolved, never a toast, and announced as an alert. It pushes the content down instead of covering it.
 *
 * It opens and closes with height and opacity over 250 ms (opacity only under reduced motion). The closing needs an
 * `AnimatePresence` around it, which keeps it on screen until it has faded (`BannerRow`). It clips its content while it
 * moves, and not at rest, where the shadow of the glass reaches beyond the row. The row that animates has no padding of its
 * own: with `box-sizing: border-box` a padded row cannot be shorter than its padding, so its first frame would be 8 px
 * high instead of 0 and the content below would jump. The gutters (8 px at the sides and below) belong to an element inside it.
 */
export function Banner({ error, onDismiss }: BannerProps) {
  const t = useT();
  const motionProps = useRevealMotion();
  const present = useIsPresent();
  const [moving, setMoving] = useState(false);
  return (
    <motion.div
      {...motionProps}
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
      className={cx('shrink-0', moving || !present ? 'overflow-hidden' : 'overflow-visible')}
    >
      <div className="px-2 pb-2">
        <div
          role="alert"
          className="bg-panel border border-border-subtle shadow-floating flex min-h-banner-min items-center gap-2 rounded-panel py-2 pe-2 ps-4"
        >
          <span className="shrink-0 text-error-text">
            <Icon icon={CircleAlert} />
          </span>
          <span className="min-w-0 flex-auto text-error-text">{errorText(t, error)}</span>
          <IconButton label={t('action.dismiss')} icon={X} size="sm" onClick={onDismiss} />
        </div>
      </div>
    </motion.div>
  );
}

/**
 * The banner slot of the shell: the error the `ui` store holds, if any. It subscribes to that one field, so an error
 * appearing or being dismissed re-renders this and not the shell.
 */
export function BannerRow() {
  const error = useUi((state) => state.banner);
  return (
    // Without `initial={false}` an error that is there at the first paint would still open from zero.
    <AnimatePresence initial={false}>
      {error !== null && <Banner key="banner" error={error} onDismiss={dismissBanner} />}
    </AnimatePresence>
  );
}

function dismissBanner(): void {
  useUi.getState().dismissBanner();
}

/**
 * The XFA warning (DESIGN 3.21, banner 3.12): shown while the active document is an XFA form, which PDFium here cannot show.
 * `role=status` (a notice, not an alert). The dismissal is per document and lasts for the session (the `ui` store, so a remount
 * keeps it); another tab has its own.
 */
export function XfaBannerRow() {
  const t = useT();
  const motionProps = useRevealMotion();
  const xfa = useDocuments((state) => selectActiveDocument(state)?.flags?.xfa === true);
  const activeId = useDocuments((state) => state.activeId);
  const dismissed = useUi((state) => activeId !== null && state.xfaDismissed.includes(activeId));
  const show = xfa && activeId !== null && !dismissed;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="xfa" {...motionProps} className="shrink-0">
          <div className="px-2 pb-2">
            <div
              role="status"
              className="bg-panel border border-border-subtle shadow-floating flex min-h-banner-min items-center gap-2 rounded-panel py-2 pe-2 ps-4"
            >
              <span className="shrink-0 text-text">
                <Icon icon={TriangleAlert} />
              </span>
              <span className="min-w-0 flex-auto text-text">{t('xfa.message', { app: APP_NAME })}</span>
              <IconButton
                label={t('xfa.dismiss')}
                icon={X}
                size="sm"
                onClick={() => useUi.getState().dismissXfa(activeId)}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
