import { useForms } from '../forms/store';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';

/** The banner rows, in priority order (DESIGN v2 3.2): at most one is visible, so the canvas is never squeezed. */
export type BannerKind = 'redact' | 'form' | 'other';

/** Whether the redact band is wanted: the mode is on in the active document. */
export function useRedactBandWanted(): boolean {
  const docId = useDocuments(selectActiveId);
  return useUi((state) => state.redactMode) && docId !== null;
}

/** Whether the form banner is wanted: the active document has fields and the banner was not closed. */
export function useFormBannerWanted(): boolean {
  const docId = useDocuments(selectActiveId);
  const has = useForms((state) => docId !== null && (state.byDoc[docId]?.fields.length ?? 0) > 0);
  const dismissed = useForms((state) => docId !== null && state.bannerDismissed[docId] === true);
  return has && !dismissed;
}

/** The banner that owns the row now: redact band, then form banner, then the other notices (which queue behind them). */
export function useBannerWinner(): BannerKind {
  const redact = useRedactBandWanted();
  const form = useFormBannerWanted();
  if (redact) return 'redact';
  if (form) return 'form';
  return 'other';
}
