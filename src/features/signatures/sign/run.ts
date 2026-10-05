import { toAppError, type AppError } from '../../../api/errors';
import type { SaveResult } from '../../../api/save';
import { signDocument, type SignLock, type SigningIdentityInfo } from '../../../api/signing';
import { tokenPx } from '../../../components/tokens';
import { renderCache } from '../../../engine/renderCache';
import { useAnnotations } from '../../../stores/annotations';
import { useDocuments } from '../../../stores/documents';
import { checkSignatures, useSigcheck } from '../../sigcheck/store';
import { adoptOpenOutcomes } from '../../viewer/useViewer';
import type { SealBox } from './store';

/** The seal box in page space (points), the default and the minimum of DESIGN 3.8 (`--seal-*`; the page space has no CSS). */
export const SEAL_DEFAULT = {
  get w(): number {
    return tokenPx('--seal-width', 192);
  },
  get h(): number {
    return tokenPx('--seal-height', 64);
  },
};
export const SEAL_MIN = {
  get w(): number {
    return tokenPx('--seal-min-width', 120);
  },
  get h(): number {
    return tokenPx('--seal-min-height', 40);
  },
};
/** A click places the default box at least this far from the page edge. */
export const SEAL_INSET_PT = 12;

export interface SignInput {
  identity: SigningIdentityInfo;
  box: SealBox;
  reason: string;
  location: string;
  lock?: SignLock;
}

export type SignOutcome =
  | { type: 'signed'; result: SaveResult; inPlace: boolean }
  | { type: 'cancelled' }
  | { type: 'failed'; error: AppError };

/**
 * Signs `input.box.docId` into a file the user picks (the backend shows the dialog). The signed file opens in a new tab and the
 * original keeps its state; only when the user chose the open file's own path does this tab reload as the signed file (S3 step 3).
 * Never rejects: a refusal (`unsupported_feature` for a protected or XFA file, `read_only` certified, `unsaved_changes`, an expired
 * identity) comes back as `failed` with the backend's error.
 */
export async function signWithCertificate(input: SignInput): Promise<SignOutcome> {
  const { identity, box, reason, location, lock = 'noChanges' } = input;
  try {
    const result = await signDocument(box.docId, {
      identityId: identity.id,
      placement: { pageId: box.pageIndex, rect: box.rect },
      art: null,
      reason: reason.trim() === '' ? null : reason.trim(),
      location: location.trim() === '' ? null : location.trim(),
      lock,
    });
    if (result === null) return { type: 'cancelled' };
    const inPlace = result.document.id === box.docId;
    if (inPlace) {
      useAnnotations.getState().applyChanges(box.docId, result.changes);
      useDocuments.setState((state) => ({ byId: { ...state.byId, [box.docId]: result.document } }));
      renderCache.dropDocument(box.docId);
      renderCache.admit(box.docId);
      // The old check described the file before signing: forget it (and a closed banner) and check the signed file now.
      useSigcheck.getState().remove(box.docId);
      void checkSignatures(box.docId, true);
    } else {
      adoptOpenOutcomes([{ type: 'opened', document: result.document }]);
    }
    return { type: 'signed', result, inPlace };
  } catch (caught) {
    return { type: 'failed', error: toAppError(caught) };
  }
}
