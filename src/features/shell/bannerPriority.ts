import { useForms } from '../forms/store';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useOcr } from '../ocr/store';
import { useSigBannerWanted } from '../sigcheck/hooks';

/** The banner rows, in priority order (DESIGN v2 3.2, 3.12 O1): at most one is visible, so the canvas is never squeezed. */
export type BannerKind = 'redact' | 'signature' | 'ocr' | 'form' | 'other';

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

/** Whether the OCR progress banner is wanted: a recognition run is going in the active tab. */
export function useOcrProgressWanted(): boolean {
  const docId = useDocuments(selectActiveId);
  return useOcr((state) => docId !== null && state.runs[docId] !== undefined);
}

/**
 * The banner that owns the row now: redact band, then signature banner, then OCR progress, then form banner, then the other notices
 * (which queue behind them; the OCR offer is the lowest and shows only with no banner above it).
 */
export function useBannerWinner(): BannerKind {
  const redact = useRedactBandWanted();
  const signature = useSigBannerWanted();
  const ocr = useOcrProgressWanted();
  const form = useFormBannerWanted();
  if (redact) return 'redact';
  if (signature) return 'signature';
  if (ocr) return 'ocr';
  if (form) return 'form';
  return 'other';
}
