import { create } from 'zustand';

import { toAppError, type AppError } from '../../../api/errors';
import {
  IDENTITIES_MAX,
  createSigningIdentity,
  deleteSigningIdentity,
  exportSigningCertificate,
  listSigningIdentities,
  type NewIdentitySpec,
  type SigningIdentityInfo,
  type StoreStatus,
} from '../../../api/signing';
import { refreshSigningIdentities } from '../sign';

/** The certificate list of the Certificates tab (DESIGN 3.8 S2). The keys stay in Rust; this holds the public summaries only. */
export interface CertificatesState {
  status: StoreStatus;
  items: readonly SigningIdentityInfo[];
  /** The list has been asked for at least once since the tab opened. */
  loaded: boolean;
  error: AppError | null;
  /** The row to highlight after Create or Import. */
  selectedId: string | null;
}

export const useCertificates = create<CertificatesState>()(() => ({
  status: 'ready',
  items: [],
  loaded: false,
  error: null,
  selectedId: null,
}));

const set = useCertificates.setState;

/** Reads the identities. A failure keeps what is shown and says so. */
export async function refreshCertificates(): Promise<void> {
  try {
    const list = await listSigningIdentities();
    set({ status: list.status, items: list.items, loaded: true, error: null });
  } catch (caught) {
    set({ loaded: true, error: toAppError(caught) });
  }
}

/** Whether Create and Import are possible: a usable keychain and fewer than 8 identities. */
export function canAdd(status: StoreStatus, count: number): boolean {
  return (status === 'ready' || status === 'empty') && count < IDENTITIES_MAX;
}

/** Makes a self-signed identity and selects its row. Rejects with the backend error. */
export async function createCertificate(spec: NewIdentitySpec): Promise<SigningIdentityInfo> {
  const created = await createSigningIdentity(spec);
  void refreshSigningIdentities();
  set((state) => ({ items: [...state.items, created], selectedId: created.id, status: 'ready', error: null }));
  return created;
}

/** Adds an identity the import produced and selects its row. */
export function addImported(info: SigningIdentityInfo): void {
  void refreshSigningIdentities();
  set((state) => ({
    items: [...state.items.filter((item) => item.id !== info.id), info],
    selectedId: info.id,
    status: 'ready',
    error: null,
  }));
}

/** Writes the public certificate to a file the user picks (Rust dialog). `false`: cancelled or failed (the error is in the state). */
export async function exportCertificate(id: string): Promise<boolean> {
  try {
    return await exportSigningCertificate(id);
  } catch (caught) {
    set({ error: toAppError(caught) });
    return false;
  }
}

/** Deletes an identity (no undo: the keychain item is gone). `not_found` counts as done. */
export async function removeCertificate(id: string): Promise<void> {
  try {
    await deleteSigningIdentity(id);
  } catch (caught) {
    const error = toAppError(caught);
    if (error.code !== 'not_found') {
      set({ error });
      return;
    }
  }
  void refreshSigningIdentities();
  set((state) => ({
    items: state.items.filter((item) => item.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
    error: null,
  }));
  await refreshCertificates();
}
