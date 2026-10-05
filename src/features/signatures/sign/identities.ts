import { useEffect } from 'react';
import { create } from 'zustand';

import { listSigningIdentities, type SigningIdentityInfo, type StoreStatus } from '../../../api/signing';

/** The signing identities as the slot and the dialog show them (read from the backend; keys never reach the frontend). */
interface IdentityState {
  status: StoreStatus | 'unknown';
  items: readonly SigningIdentityInfo[];
  set: (status: StoreStatus, items: readonly SigningIdentityInfo[]) => void;
}

export const useIdentities = create<IdentityState>()((set) => ({
  status: 'unknown',
  items: [],
  set: (status, items) => set({ status, items }),
}));

/** Reads the list again. The certificate manager calls this after it created, imported or deleted one. Never rejects. */
export async function refreshSigningIdentities(): Promise<void> {
  try {
    const list = await listSigningIdentities();
    useIdentities.getState().set(list.status, list.items);
  } catch {
    // The slot still works with what it has; the certificate manager reports a failed read.
  }
}

/** Reads the list once `enabled` first holds, and again whenever it turns true. */
export function useSigningIdentities(enabled: boolean): Pick<IdentityState, 'status' | 'items'> {
  const status = useIdentities((state) => state.status);
  const items = useIdentities((state) => state.items);
  useEffect(() => {
    if (enabled) void refreshSigningIdentities();
  }, [enabled]);
  return { status, items };
}

/** Whether an identity can sign today: it has not expired. (The backend checks again.) */
export const canSign = (identity: SigningIdentityInfo): boolean => !identity.expired;
