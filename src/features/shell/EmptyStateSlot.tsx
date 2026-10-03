import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type CSSProperties } from 'react';

import { runAction } from '../../actions/dispatch';
import { shortcutFor } from '../../actions/registry';
import type { Platform } from '../../api/app';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { SPRING } from '../../lib/motion';
import { useUi } from '../../stores/ui';
import { DropCard } from '../viewer/DropCard';
import { useTransition } from '../viewer/openTransition';
import { useViewer } from '../viewer/useViewer';
import { EmptyState } from './EmptyState';

/** After the drag left the window the card stays this long: a drop that is accepted lets it fall (MOTION 4.5); otherwise it fades out. */
export const DROP_HOLD_MS = 250;

/**
 * Whether the drop target (the card over the empty state) is shown, and whether the drop has been accepted: shown while the drag is
 * over the window and for `DROP_HOLD_MS` after it, `falling` once a document that was dropped has opened.
 */
function useDropTarget(dropActive: boolean): { shown: boolean; falling: boolean } {
  const [holding, setHolding] = useState(false);
  const accepted = useTransition((state) => state.dropAccepted);
  const [seen, setSeen] = useState(accepted);
  const [wasActive, setWasActive] = useState(dropActive);
  // A drag that has just left holds the card; one that arrives starts afresh. (Derived while rendering, not in an effect.)
  if (wasActive !== dropActive) {
    setWasActive(dropActive);
    setHolding(!dropActive);
    if (dropActive) setSeen(accepted);
  }
  const falling = accepted !== seen;
  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(() => setHolding(false), DROP_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);
  return { shown: dropActive || holding || falling, falling };
}

/**
 * The empty state in the main row's only slot, with what it needs from the stores: whether a document is being opened
 * and whether a file is dragged over the window. It subscribes to those itself, so the shell does not. Its Open button runs
 * the registry's `open` action like the key, More and the menu bar do, so all of them follow the same rules. While a file is
 * dragged over the window the drop target shows the preview card (MOTION 4.5) and the empty state behind it fades out, so
 * nothing overlaps.
 */
export function EmptyStateSlot({ platform, style }: { platform: Platform | null; style?: CSSProperties }) {
  const opening = useViewer((state) => state.opening);
  const dropActive = useUi((state) => state.dropHover);
  const t = useT();
  const openKey = shortcutFor('open', platform, t);
  const target = useDropTarget(dropActive);
  return (
    <div style={style} className="relative flex min-h-0 min-w-0 overflow-auto p-1">
      <div className={cx('flex min-w-0 flex-1 transition-opacity', target.shown ? 'opacity-0' : 'opacity-100')}>
        <EmptyState
          openShortcut={openKey?.label ?? ''}
          openKeyShortcuts={openKey?.aria ?? ''}
          opening={opening}
          onOpen={() => void runAction('open')}
          dropActive={dropActive}
        />
      </div>
      <AnimatePresence>
        {target.shown && (
          <motion.div
            key="drop-target"
            data-drop-target=""
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: SPRING.base }}
            exit={{ opacity: 0, transition: SPRING.fast }}
            className="pointer-events-none absolute inset-1 z-drag flex flex-col items-center justify-center gap-3"
          >
            <DropCard falling={target.falling} />
            <p className="m-0 font-display text-xl">{t('canvas.dropToOpen')}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
