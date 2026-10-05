import { openSignatureLibrary } from '../library/state';

/**
 * Opens the Signatures dialog (DESIGN 3.8 S2): on the Certificates tab by default, `'signatures'` for the saved signatures.
 * Without a tab the last one used this session. The split menu's "Manage certificates…" and the sign tool without a certificate call it.
 */
export function openCertificateManager(tab: 'signatures' | 'certificates' = 'certificates'): void {
  openSignatureLibrary(tab);
}
