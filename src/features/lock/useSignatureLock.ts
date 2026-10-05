import { useDocuments } from '../../stores/documents';

/** The state of the lock a signature puts on a document (DESIGN 3.8 S5). `reason` is the catalog key of the tooltip that says why. */
export interface SignatureLockState {
  locked: boolean;
  reason?: string;
}

/** The tooltip key of every disabled control (`cert.locked.tool`). */
export const LOCKED_REASON_KEY = 'cert.locked.tool';

/** Whether the document is locked by a certifying signature (no change allowed; a copy without the signatures is the way out). */
export function isSignatureLocked(docId: number | null | undefined): boolean {
  if (docId === null || docId === undefined) return false;
  return useDocuments.getState().byId[docId]?.signatureLock === 'locked';
}

/** The lock of a document, reactive. `reason` is set only while locked. */
export function useSignatureLock(docId: number | undefined): SignatureLockState {
  const locked = useDocuments((state) => docId !== undefined && state.byId[docId]?.signatureLock === 'locked');
  return locked ? { locked, reason: LOCKED_REASON_KEY } : { locked };
}
