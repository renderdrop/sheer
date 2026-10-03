import { Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { Button, IconButton } from '../../components';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { CompressDialog } from './CompressDialog';
import { MergeSheet } from './MergeSheet';
import { SignatureSheetHost } from '../signatures/create';
import { SplitDialog } from './SplitDialog';
import { discardHeld, useJobs } from './state';

/**
 * The info banner for a drop of two or more PDFs (DESIGN 3.29, banner 3.12): non-modal, so the open document stays usable. "Merge…"
 * opens the merge sheet with the files, "Open as tabs" shows them as tabs, and the x opens nothing (the backend closes them).
 */
export function DropBannerRow() {
  const t = useT();
  const motionProps = useRevealMotion();
  const drop = useJobs((state) => state.drop);
  const setDrop = useJobs((state) => state.setDrop);
  return (
    <AnimatePresence initial={false}>
      {drop !== null && (
        <motion.div key="drop" {...motionProps} className="shrink-0">
          <div className="px-1 pb-1">
            <div
              role="status"
              className="glass-1 flex min-h-banner-min items-center gap-1 rounded-panel py-1 pe-1 ps-2"
            >
              <span className="shrink-0 text-text-accent">
                <Icon icon={Info} />
              </span>
              <span className="min-w-0 flex-auto">{t('merge.suggest', { n: drop.length })}</span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  useJobs.getState().setSheet({ kind: 'merge', held: drop });
                  setDrop(null);
                }}
              >
                {t('merge.merge')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  adoptOpenOutcomes(drop.map((document) => ({ type: 'opened' as const, document })));
                  setDrop(null);
                }}
              >
                {t('merge.tabs')}
              </Button>
              <IconButton
                label={t('action.dismiss')}
                icon={X}
                size="sm"
                onClick={() => {
                  discardHeld(drop);
                  setDrop(null);
                }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The open job surface, if any (merge sheet, split or extract dialog, compress dialog). Mounted once with the shell. */
export function JobsHost() {
  const sheet = useJobs((state) => state.sheet);
  return (
    <>
      <SignatureSheetHost />
      <AnimatePresence>
        {sheet?.kind === 'merge' && <MergeSheet key="merge" held={sheet.held} />}
        {sheet?.kind === 'split' && <SplitDialog key="split" mode={sheet.mode} />}
        {sheet?.kind === 'compress' && <CompressDialog key="compress" />}
      </AnimatePresence>
    </>
  );
}
