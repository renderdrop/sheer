// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toAppError } from '../../../api/errors';
import {
  createSigningIdentity,
  deleteSigningIdentity,
  discardIdentityImport,
  importSigningIdentity,
  listSigningIdentities,
  pickIdentityFile,
  type SigningIdentityInfo,
} from '../../../api/signing';
import { setup } from '../../../test/render';
import { SignatureLibraryDialog } from '../library/SignatureLibraryDialog';
import { closeSignatureLibrary, useSignatureLibrary } from '../library/state';
import { openCertificateManager } from './open';
import { useCertificates } from './state';

vi.mock('../../../api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/library')>()),
  listSignatures: vi.fn(() => Promise.resolve({ status: 'ready', items: [] })),
}));
vi.mock('../../../api/signing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/signing')>()),
  listSigningIdentities: vi.fn(),
  createSigningIdentity: vi.fn(),
  pickIdentityFile: vi.fn(),
  importSigningIdentity: vi.fn(),
  discardIdentityImport: vi.fn(() => Promise.resolve()),
  deleteSigningIdentity: vi.fn(() => Promise.resolve()),
  exportSigningCertificate: vi.fn(() => Promise.resolve(true)),
}));

const list = vi.mocked(listSigningIdentities);
const initialLibrary = useSignatureLibrary.getState();
const initialCerts = useCertificates.getState();

function identity(n: number, extra: Partial<SigningIdentityInfo> = {}): SigningIdentityInfo {
  const name = { commonName: `Cert ${n}`, organization: null, email: null };
  return {
    subject: name,
    issuer: name,
    selfSigned: true,
    notBefore: '2026-01-01T00:00:00Z',
    notAfter: '2029-10-01T00:00:00Z',
    serialHex: 'abcd1234',
    fingerprintSha256: n.toString(16).padStart(64, 'a'),
    id: n.toString(16).padStart(32, '0'),
    source: 'generated',
    key: { type: 'ecP256' },
    chainLength: 1,
    expired: false,
    ...extra,
  };
}

function Fixture() {
  return (
    <>
      <div id="root">
        <button type="button">elsewhere</button>
      </div>
      <SignatureLibraryDialog />
    </>
  );
}

async function openWith(items: SigningIdentityInfo[], status: 'ready' | 'empty' | 'unavailable' = 'ready') {
  list.mockResolvedValue({ status, items });
  const view = setup(<Fixture />);
  act(() => openCertificateManager('certificates'));
  await waitFor(() => expect(useCertificates.getState().loaded).toBe(true));
  return view;
}

beforeEach(() => {
  useSignatureLibrary.setState({ ...initialLibrary, open: false, items: [], deleted: new Set<string>() }, true);
  useCertificates.setState({ ...initialCerts, items: [], loaded: false, error: null, selectedId: null }, true);
  list.mockReset();
  for (const mock of [createSigningIdentity, pickIdentityFile, importSigningIdentity, deleteSigningIdentity]) {
    vi.mocked(mock).mockReset();
  }
  vi.mocked(deleteSigningIdentity).mockResolvedValue(undefined);
  vi.mocked(discardIdentityImport).mockClear();
});

afterEach(() => {
  act(() => closeSignatureLibrary());
});

describe('certificate manager', () => {
  it('opens on the Certificates tab and lists identities with their origin and validity', async () => {
    await openWith([
      identity(1),
      identity(2, {
        source: 'imported',
        selfSigned: false,
        issuer: { commonName: 'Acme CA', organization: null, email: null },
      }),
    ]);
    expect(screen.getByRole('tab', { name: 'Certificates', selected: true })).toBeTruthy();
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Self-generated');
    expect(rows[0]?.textContent).toContain('valid until');
    expect(rows[1]?.textContent).toContain('Imported · issued by Acme CA');
  });

  it('shows the empty state with both actions', async () => {
    await openWith([], 'empty');
    expect(screen.getByText('No certificates yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create certificate…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import .p12 or .pfx…' })).toBeTruthy();
  });

  it('marks an expired certificate', async () => {
    await openWith([identity(1, { expired: true })]);
    expect(screen.getByText(/Expired on/)).toBeTruthy();
  });

  it('disables Create and Import and says why when the keychain is missing', async () => {
    await openWith([], 'unavailable');
    expect(screen.getByText(/need the system keychain/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create certificate…' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Import .p12 or .pfx…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('disables Create and Import at eight identities', async () => {
    await openWith(Array.from({ length: 8 }, (_, n) => identity(n + 1)));
    expect(screen.getByText('Up to 8 certificates.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create certificate…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('expands details with the fingerprint in blocks of four hex pairs and the Export button', async () => {
    const { user } = await openWith([identity(1)]);
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('SHA-256 fingerprint')).toBeTruthy();
    expect(document.querySelector('[data-fingerprint]')?.textContent).toBe(
      `${Array(7).fill('AA:AA:AA:AA').join(' ')} AA:AA:AA:A1`,
    );
    expect(screen.getByRole('button', { name: 'Export certificate…' })).toBeTruthy();
  });

  it('creates a certificate with only a name and selects the new row', async () => {
    const created = identity(3);
    vi.mocked(createSigningIdentity).mockResolvedValue(created);
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Create certificate…' }));
    expect(screen.getByRole('heading', { name: 'New certificate' })).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), '  Ada  ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(createSigningIdentity).toHaveBeenCalledWith({ name: 'Ada', email: null, organization: null });
    await screen.findByRole('list');
    expect(useCertificates.getState().selectedId).toBe(created.id);
    expect(screen.getByText('Cert 3')).toBeTruthy();
  });

  it('rejects an invalid email on blur and does not create', async () => {
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Create certificate…' }));
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email (optional)'), 'nope');
    await user.tab();
    expect(screen.getByLabelText('Email (optional)').getAttribute('aria-invalid')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(createSigningIdentity).not.toHaveBeenCalled();
  });

  it('keeps the form and says so when the keychain refuses', async () => {
    vi.mocked(createSigningIdentity).mockRejectedValue({ code: 'keychain_unavailable', retryable: false });
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Create certificate…' }));
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toContain('keychain');
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('Esc closes the form first, then the dialog', async () => {
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Create certificate…' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Create certificate…' })).toBeTruthy();
    expect(useSignatureLibrary.getState().open).toBe(true);
    await user.keyboard('{Escape}');
    expect(useSignatureLibrary.getState().open).toBe(false);
  });

  it('imports with the right password and shows a wrong one under the field', async () => {
    vi.mocked(pickIdentityFile).mockResolvedValue({ ticket: 7, displayName: 'me.p12' });
    vi.mocked(importSigningIdentity)
      .mockRejectedValueOnce(toAppError({ code: 'password_required', retryable: true }))
      .mockResolvedValueOnce(identity(4, { source: 'imported' }));
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Import .p12 or .pfx…' }));
    expect(await screen.findByText('me.p12')).toBeTruthy();
    const field = screen.getByLabelText('Password of the file');
    expect(field.getAttribute('type')).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field.getAttribute('type')).toBe('text');
    await user.type(field, 'bad');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong password.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await user.type(field, 'good');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    await screen.findByRole('list');
    expect(importSigningIdentity).toHaveBeenLastCalledWith(7, 'good');
    expect(screen.getByText('Cert 4')).toBeTruthy();
  });

  it('shows the file error and drops the picked file on Back', async () => {
    vi.mocked(pickIdentityFile).mockResolvedValue({ ticket: 9, displayName: 'x.pfx' });
    vi.mocked(importSigningIdentity).mockRejectedValue(
      toAppError({ code: 'invalid_argument', retryable: false, params: { what: 'identityFile' } }),
    );
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Import .p12 or .pfx…' }));
    await user.type(await screen.findByLabelText('Password of the file'), 'pw');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('no usable certificate');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(discardIdentityImport).toHaveBeenCalledWith(9));
  });

  it('does nothing when the file dialog is cancelled', async () => {
    vi.mocked(pickIdentityFile).mockResolvedValue(null);
    const { user } = await openWith([], 'empty');
    await user.click(screen.getByRole('button', { name: 'Import .p12 or .pfx…' }));
    expect(screen.getByText('No certificates yet.')).toBeTruthy();
  });

  it('deletes after an inline confirm, with no undo, and focuses the next row', async () => {
    const { user } = await openWith([identity(1), identity(2)]);
    await user.click(screen.getAllByRole('button', { name: 'Delete certificate' })[0] as HTMLElement);
    expect(screen.getByRole('alert').textContent).toContain('Delete “Cert 1” from this device?');
    expect(deleteSigningIdentity).not.toHaveBeenCalled();
    list.mockResolvedValue({ status: 'ready', items: [identity(2)] });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteSigningIdentity).toHaveBeenCalledWith(identity(1).id));
    await waitFor(() => expect(screen.queryByText('Cert 1')).toBeNull());
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute('data-cert-details')).toBe(identity(2).id));
  });

  it('cancelling the confirm keeps the row', async () => {
    const { user } = await openWith([identity(1)]);
    await user.click(screen.getByRole('button', { name: 'Delete certificate' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Cert 1')).toBeTruthy();
    expect(deleteSigningIdentity).not.toHaveBeenCalled();
  });

  it('switches tabs and remembers the last one', async () => {
    const { user } = await openWith([identity(1)]);
    await user.click(screen.getByRole('tab', { name: 'Signatures' }));
    expect(useSignatureLibrary.getState().tab).toBe('signatures');
    expect(screen.queryByRole('button', { name: 'Create certificate…' })).toBeNull();
  });
});
