import { ShieldAlert, ShieldCheck, ShieldX, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { Button, IconButton, Icon, Tooltip } from '../../components';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useBannerWinner } from '../shell/bannerPriority';
import { makeEditableCopy } from './actions';
import { useActiveCheck, useNarrow, useSigBannerWanted, useSigcheckEffects } from './hooks';
import { openSignaturesDialog } from './open';
import { useSigcheck } from './store';
import { identityUnchecked, isBad, signaturesOf, signerName, worstOf, type SigState } from './summary';

export const STATE_ICON: Record<SigState, LucideIcon> = {
  intact: ShieldCheck,
  later: ShieldCheck,
  changed: ShieldAlert,
  unknown: ShieldX,
};

/**
 * The signature banner (DESIGN v1.4 S6, banner slot priority redact > signature > form): who signed, the worst state of all
 * signatures, a plain-words trust notice, Details and a close for this tab's session. A locked document also gets the editable copy
 * on the right (S5). The state is words first; colour only repeats it. Checks run in the background (`useSigcheckEffects`).
 */
export function SigBanner() {
  useSigcheckEffects();
  const t = useT();
  const motionProps = useRevealMotion();
  const check = useActiveCheck();
  const wanted = useSigBannerWanted();
  const show = useBannerWinner() === 'signature' && wanted && check !== null;
  const narrow = useNarrow();
  const locked = useDocuments((state) => selectActiveDocument(state)?.signatureLock === 'locked');
  const entry = check?.entry;
  const docId = check?.docId ?? -1;

  let text = '';
  let state: SigState = 'intact';
  let identity = false;
  if (entry?.status === 'checking') {
    text = t('sigs.checking');
  } else if (entry?.status === 'failed') {
    state = 'unknown';
    text = t('sigs.state.unknown');
  } else if (entry?.status === 'ready') {
    const sigs = signaturesOf(entry.report);
    state = worstOf(sigs);
    identity = identityUnchecked(sigs);
    const subject =
      sigs.length === 1 && sigs[0] !== undefined
        ? t('sigs.banner.single', { name: signerName(sigs[0]) })
        : t('sigs.banner.multiple', { count: sigs.length });
    const word =
      state === 'intact'
        ? t('sigs.state.intact')
        : state === 'later'
          ? t('sigs.state.later')
          : state === 'changed'
            ? t('sigs.state.changed')
            : t('sigs.state.unknown');
    text = `${subject} · ${word}`;
  }
  const bad = isBad(state);
  const identityText = t('sigs.identity.short');
  const checking = entry?.status === 'checking';

  const label = (
    <span className={`min-w-0 flex-auto ${bad ? 'font-semibold' : ''}`} data-sig-text="">
      {text}
      {identity && !narrow && ` · ${identityText}`}
    </span>
  );

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="signature" {...motionProps} className="shrink-0">
          <div className="px-2 pb-2">
            <div
              role="status"
              data-banner="signature"
              data-state={checking ? 'checking' : state}
              className="t-label flex min-h-control-lg items-center gap-2 rounded-md bg-subtle py-1 pe-1 ps-4 text-text"
            >
              <span className={`shrink-0 ${bad ? 'text-danger' : 'text-text'}`}>
                <Icon icon={STATE_ICON[state]} />
              </span>
              {identity && narrow ? <Tooltip label={identityText}>{label}</Tooltip> : label}
              {entry?.status !== 'checking' && (
                <Button variant="ghost" size="sm" onClick={() => openSignaturesDialog(docId)}>
                  {t('sigs.details')}
                </Button>
              )}
              {locked && (
                <Button variant="ghost" size="sm" onClick={() => void makeEditableCopy(docId)}>
                  {t('cert.editableCopy')}
                </Button>
              )}
              <IconButton
                label={t('action.dismiss')}
                icon={X}
                size="sm"
                onClick={() => useSigcheck.getState().dismiss(docId)}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
