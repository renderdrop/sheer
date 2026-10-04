import { TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { Button, Icon } from '../../components';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { enterRedactMode } from './actions';
import { useRedact } from './store';
import { useRedactHost } from './useRedactHost';

/**
 * The pending-marks warning banner (DESIGN 3.38, banner 3.12): shown while the active tab holds marks and the mode is off; saving
 * stays allowed and the banner stays. `role=status` (a notice, not an alert). Review opens the mode again. It also installs the
 * mode's host (`useRedactHost`), because it is always mounted in the shell.
 */
export function RedactBanner() {
  useRedactHost();
  const t = useT();
  const motionProps = useRevealMotion();
  const docId = useDocuments(selectActiveId);
  const count = useRedact((state) => (docId === null ? 0 : Object.keys(state.marks[docId] ?? {}).length));
  const mode = useUi((state) => state.redactMode);
  const show = docId !== null && count > 0 && !mode;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="redact" {...motionProps} className="shrink-0">
          <div className="px-2 pb-2">
            <div
              role="status"
              className="bg-panel border border-border-subtle shadow-floating flex min-h-banner-min items-center gap-2 rounded-panel py-2 pe-2 ps-4"
            >
              <span className="shrink-0 text-text">
                <Icon icon={TriangleAlert} />
              </span>
              <span className="min-w-0 flex-auto text-text">{t('redact.pending', { n: count })}</span>
              <Button variant="secondary" size="sm" onClick={enterRedactMode}>
                {t('redact.review')}
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
