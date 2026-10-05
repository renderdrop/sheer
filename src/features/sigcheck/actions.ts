import { toAppError } from '../../api/errors';
import { openSignedRevision, saveUnsignedCopy } from '../../api/signing';
import { useUi } from '../../stores/ui';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { jumpToHit } from '../search/jump';
import { useSigcheck } from './store';
import { rectQuad } from './summary';

/** How long "Show on page" keeps the seal outlined when motion is reduced to a hold (`--hold-outline`). */
export const SHOWN_MS = 1000;
let shownTimer: number | undefined;

/** Makes the editable copy (the Rust save dialog; a copy without signatures) and opens it in a new tab. */
export async function makeEditableCopy(docId: number): Promise<void> {
  try {
    const outcome = await saveUnsignedCopy(docId);
    if (outcome !== null) adoptOpenOutcomes([outcome]);
  } catch (error) {
    useUi.getState().showBanner(toAppError(error));
  }
}

/** Opens what signature `index` covers as a read-only document in a new tab. */
export async function viewSignedVersion(docId: number, index: number): Promise<void> {
  try {
    adoptOpenOutcomes([await openSignedRevision(docId, index)]);
  } catch (error) {
    useUi.getState().showBanner(toAppError(error));
  }
}

/** Scrolls to the seal of a signature and outlines it for a moment. */
export function showOnPage(
  docId: number,
  index: number,
  widget: { pageId: number; rect: { x: number; y: number; w: number; h: number } },
): void {
  jumpToHit(docId, { index: -1, page: widget.pageId, quads: [rectQuad(widget.rect)] });
  useSigcheck.getState().show({ docId, index });
  window.clearTimeout(shownTimer);
  shownTimer = window.setTimeout(() => useSigcheck.getState().show(null), SHOWN_MS);
}
