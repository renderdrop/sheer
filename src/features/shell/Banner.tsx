import { CircleAlert, X } from 'lucide-react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useState } from 'react';

import { IconButton } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { errorText, useT } from '../../i18n';
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
 * moves, and not at rest, where the shadow of the glass reaches beyond the row.
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
      className={cx('shrink-0 px-1 pb-1', moving || !present ? 'overflow-hidden' : 'overflow-visible')}
    >
      <div role="alert" className="glass-1 flex min-h-banner-min items-center gap-1 rounded-panel py-1 pe-1 ps-2">
        <span className="shrink-0 text-error-icon">
          <Icon icon={CircleAlert} />
        </span>
        <span className="min-w-0 flex-auto text-error-text">{errorText(t, error)}</span>
        <IconButton label={t('action.dismiss')} icon={X} size="sm" onClick={onDismiss} />
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
