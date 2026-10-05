import { toAppError } from '../../api/errors';
import { openSignedRevision, saveUnsignedCopy } from '../../api/signing';
import { DEFAULT_PAGE_SIZE, positionOf, sizesFor, usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { fileRotationOf } from '../viewer/fileRotation';
import { unrotatedSize } from '../viewer/transform';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { jumpToHit } from '../search/jump';
import { useSigcheck } from './store';
import { rectQuad, sealBox } from './summary';

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
  // The rectangle is the file's (y up); the jump wants the unrotated page with y down.
  const view = useView.getState().byDoc[docId];
  const sizes = view === undefined ? [] : sizesFor(usePages.getState(), docId, view.pageCount);
  const drawn = sizes[positionOf(docId, widget.pageId) ?? -1] ?? DEFAULT_PAGE_SIZE;
  const page = unrotatedSize(drawn, fileRotationOf(docId, widget.pageId));
  jumpToHit(docId, { index: -1, page: widget.pageId, quads: [rectQuad(sealBox(widget.rect, page[1]))] });
  useSigcheck.getState().show({ docId, index });
  window.clearTimeout(shownTimer);
  shownTimer = window.setTimeout(() => useSigcheck.getState().show(null), SHOWN_MS);
}
