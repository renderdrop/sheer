import { useEffect, useState } from 'react';

import { useT } from '../../i18n';
import { selectActiveDocument, selectActiveId, useDocuments } from '../../stores/documents';
import { checkSignatures, useSigcheck, type CheckEntry } from './store';

/** "Checking…" shows only when the check takes longer than this (`--saving-delay`, MOTION spell 6). */
export const CHECKING_SHOWN_AFTER_MS = 200;

/** Whether `flag` has been true for `ms` without a break. */
function useAfter(flag: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const timer = window.setTimeout(() => setLate(true), ms);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [flag, ms]);
  return flag && late;
}

/** Whether the active document has a signed signature field that is worth checking (the read-only view of a signed revision is not). */
export function useActiveSigned(): number | null {
  const docId = useDocuments(selectActiveId);
  const signed = useDocuments((state) => {
    const document = selectActiveDocument(state);
    return document !== null && document.flags?.signed === true && document.kind !== 'signedRevision';
  });
  return signed ? docId : null;
}

/** The check of the active document, when it is signed. */
export function useActiveCheck(): { docId: number; entry: CheckEntry | undefined } | null {
  const docId = useActiveSigned();
  const entry = useSigcheck((state) => (docId === null ? undefined : state.byDoc[docId]));
  return docId === null ? null : { docId, entry };
}

/** Whether the signature banner is wanted: a signed document with something to say, not closed for this session. */
export function useSigBannerWanted(): boolean {
  const docId = useActiveSigned();
  const entry = useSigcheck((state) => (docId === null ? undefined : state.byDoc[docId]));
  const dismissed = useSigcheck((state) => docId !== null && state.dismissed[docId] === true);
  const slow = useAfter(entry?.status === 'checking', CHECKING_SHOWN_AFTER_MS);
  if (docId === null || dismissed || entry === undefined) return false;
  if (entry.status === 'checking') return slow;
  if (entry.status === 'failed') return true;
  return entry.report.signatures.length > 0;
}

/** The texts of this feature (`sigcheck.*` in the catalog), under the names the components use. */
export function useLocal() {
  const t = useT();
  return {
    trust: t('sigcheck.trust'),
    untrust: t('sigcheck.untrust'),
    viewSigned: t('sigcheck.viewSigned'),
    later: t('sigcheck.addedAfter'),
    own: t('sigcheck.own'),
    trusted: t('sigcheck.trusted'),
    timeout: t('sigcheck.timeout'),
    trustedList: t('sigcheck.trustedList'),
    removePin: t('sigcheck.removePin'),
    wholeFile: t('sigcheck.wholeFile'),
    'later.signatures': t('sigcheck.addedSignatures'),
    'later.formFill': t('sigcheck.addedFormFill'),
    'later.annotations': t('sigcheck.addedAnnotations'),
    'later.other': t('sigcheck.addedOther'),
  };
}

/** The window is narrower than the width at which the banner drops the identity part (DESIGN v1.4 S6: 1100). */
export function useNarrow(limit = 1100): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < limit);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < limit);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [limit]);
  return narrow;
}

/** Checks the signatures of the active document once it is signed, and forgets the checks of closed documents. Mount once. */
export function useSigcheckEffects(): void {
  const docId = useActiveSigned();
  useEffect(() => {
    if (docId !== null) void checkSignatures(docId);
  }, [docId]);
  useEffect(
    () =>
      useDocuments.subscribe((state, previous) => {
        for (const id of Object.keys(previous.byId)) {
          if (state.byId[Number(id)] === undefined) useSigcheck.getState().remove(Number(id));
        }
      }),
    [],
  );
}
