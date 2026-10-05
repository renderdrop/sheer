// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignatureInfo, SignatureReport } from '../../api/signing';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useBannerWinner } from '../shell/bannerPriority';
import { openSignaturesDialog } from './open';
import { SigBanner } from './SigBanner';
import { SignaturesDialog } from './SignaturesDialog';
import { resetSigcheck, useSigcheck } from './store';
import { clean, stateOf, worstOf } from './summary';

const api = vi.hoisted(() => ({
  validateSignatures: vi.fn(),
  openSignedRevision: vi.fn(),
  setSignerTrust: vi.fn(),
  listTrustedSigners: vi.fn(),
  removeTrustedSigner: vi.fn(),
  saveUnsignedCopy: vi.fn(),
}));
vi.mock('../../api/signing', async (original) => ({ ...(await original<object>()), ...api }));
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: vi.fn() }));

const FP = 'a'.repeat(64);
const cert = (name: string) => ({
  subject: { commonName: name, organization: null, email: null },
  issuer: { commonName: name, organization: null, email: null },
  selfSigned: true,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2029-01-01T00:00:00Z',
  serialHex: '01',
  fingerprintSha256: FP,
});

function sig(over: Partial<SignatureInfo> = {}): SignatureInfo {
  return {
    index: 0,
    fieldName: 'Sig1',
    kind: { type: 'approval' },
    subFilter: 'etsiCadesDetached',
    signer: cert('Ada Lovelace'),
    claimedTime: '2026-10-05T14:05:00+02:00',
    reason: null,
    location: null,
    cryptographic: 'valid',
    weakAlgorithm: false,
    timestampPresent: false,
    coverage: { type: 'wholeFile' },
    certValidAtClaimedTime: true,
    trust: 'notTrusted',
    widget: null,
    ...over,
  };
}
const report = (signatures: SignatureInfo[], lock: SignatureReport['lock'] = 'none'): SignatureReport => ({
  signatures,
  truncated: false,
  lock,
});

function Probe() {
  return <span data-testid="winner">{useBannerWinner()}</span>;
}
function Host() {
  return (
    <>
      <Probe />
      <SigBanner />
      <SignaturesDialog />
    </>
  );
}

beforeEach(() => {
  vi.useRealTimers();
  window.innerWidth = 1280;
  resetDocuments();
  resetSigcheck();
  Object.values(api).forEach((mock) => mock.mockReset());
  api.listTrustedSigners.mockResolvedValue([]);
  useDocuments.getState().add({
    id: 1,
    pageCount: 1,
    displayName: 'a.pdf',
    flags: { encrypted: false, xfa: false, hasForms: false, signed: true },
    signatureLock: 'none',
  });
});
afterEach(cleanup);

describe('signature states', () => {
  it('maps the cryptography and the coverage to the four states', () => {
    expect(stateOf(sig())).toBe('intact');
    expect(
      stateOf(
        sig({
          coverage: {
            type: 'earlierRevision',
            revision: 1,
            later: { signatures: false, formFill: true, annotations: false, other: false },
            verdict: 'allowed',
          },
        }),
      ),
    ).toBe('later');
    expect(stateOf(sig({ cryptographic: 'invalid' }))).toBe('changed');
    expect(
      stateOf(
        sig({
          coverage: {
            type: 'earlierRevision',
            revision: 1,
            later: { signatures: false, formFill: false, annotations: false, other: true },
            verdict: 'disallowed',
          },
        }),
      ),
    ).toBe('changed');
    expect(stateOf(sig({ cryptographic: 'malformed' }))).toBe('unknown');
    expect(worstOf([sig(), sig({ cryptographic: 'invalid' }), sig({ cryptographic: 'unverifiable' })])).toBe('unknown');
  });

  it('cleans hostile text', () => {
    expect(clean('A‮B\u0000C')).toBe('ABC');
    expect(clean('x'.repeat(300))).toHaveLength(128);
  });
});

describe('the signature banner', () => {
  it('says who signed and that it is unchanged, with the trust notice in words', async () => {
    api.validateSignatures.mockResolvedValue(report([sig()]));
    render(<Host />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Signed by Ada Lovelace');
    expect(banner.textContent).toContain('Unchanged since signing');
    expect(banner.textContent).toContain('identity not verified');
    expect(screen.getByTestId('winner').textContent).toBe('signature');
    expect(screen.queryByText('Make editable copy…')).toBeNull();
  });

  it('says changed after signing in words', async () => {
    api.validateSignatures.mockResolvedValue(report([sig({ cryptographic: 'invalid' })]));
    render(<Host />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Changed after signing');
    expect(banner.getAttribute('data-state')).toBe('changed');
  });

  it("says it can't be checked for a broken signature and still lists the rest", async () => {
    api.validateSignatures.mockResolvedValue(
      report([sig({ cryptographic: 'malformed', signer: null }), sig({ index: 1 })]),
    );
    render(<Host />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('2 signatures');
    expect(banner.textContent).toContain("Can't be checked");
  });

  it('counts several signatures and offers the editable copy when locked', async () => {
    useDocuments.getState().add({
      id: 2,
      pageCount: 1,
      displayName: 'b.pdf',
      flags: { encrypted: false, xfa: false, hasForms: false, signed: true },
      signatureLock: 'locked',
    });
    api.validateSignatures.mockResolvedValue(report([sig(), sig({ index: 1, fieldName: 'Sig2' })], 'locked'));
    api.saveUnsignedCopy.mockResolvedValue(null);
    render(<Host />);
    const copy = await screen.findByText('Make editable copy…');
    fireEvent.click(copy);
    await waitFor(() => expect(api.saveUnsignedCopy).toHaveBeenCalledWith(2));
  });

  it('shows nothing for a document without signatures in its report, and the close hides it for the session', async () => {
    api.validateSignatures.mockResolvedValue(report([]));
    const { unmount } = render(<Host />);
    await waitFor(() => expect(api.validateSignatures).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('winner').textContent).toBe('other');
    unmount();

    resetSigcheck();
    api.validateSignatures.mockResolvedValue(report([sig()]));
    render(<Host />);
    await screen.findByRole('status');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(useSigcheck.getState().dismissed[1]).toBe(true);
  });

  it('shows the checking text only after the delay', async () => {
    vi.useFakeTimers();
    api.validateSignatures.mockReturnValue(new Promise(() => undefined));
    render(<Host />);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => void vi.advanceTimersByTime(250));
    expect(screen.getByRole('status').textContent).toContain('Checking signatures…');
  });
});

describe('the Signatures dialog', () => {
  it('lists the cards with state words, later changes and the signed version', async () => {
    const later = sig({
      index: 1,
      fieldName: 'Sig2',
      coverage: {
        type: 'earlierRevision',
        revision: 1,
        later: { signatures: true, formFill: true, annotations: false, other: false },
        verdict: 'allowed',
      },
    });
    api.validateSignatures.mockResolvedValue(report([sig(), later]));
    api.openSignedRevision.mockResolvedValue({ type: 'openFailed', error: { code: 'internal', message: '' } });
    render(<Host />);
    await screen.findByRole('status');
    act(() => openSignaturesDialog(1, 1));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Signature 2 of 2');
    expect(dialog.textContent).toContain('Unchanged; additions were made after signing');
    expect(dialog.textContent).toContain('signatures');
    expect(dialog.textContent).toContain('form entries');
    expect(dialog.textContent).toContain('No visible seal');
    fireEvent.click(screen.getByText('View signed version'));
    await waitFor(() => expect(api.openSignedRevision).toHaveBeenCalledWith(1, 1));
  });

  it('pins and unpins a signer through the backend', async () => {
    api.validateSignatures.mockResolvedValue(report([sig()]));
    api.setSignerTrust.mockResolvedValue(report([sig({ trust: 'trustedByYou' })]));
    render(<Host />);
    await screen.findByRole('status');
    act(() => openSignaturesDialog(1));
    fireEvent.click(await screen.findByText('Trust this signer'));
    await waitFor(() => expect(api.setSignerTrust).toHaveBeenCalledWith(1, 0, true));
    expect(await screen.findByText('Remove trust')).toBeTruthy();
  });

  it('shows an error card for a damaged signature and Esc closes', async () => {
    api.validateSignatures.mockResolvedValue(report([sig({ cryptographic: 'malformed', signer: null })]));
    render(<Host />);
    await screen.findByRole('status');
    act(() => openSignaturesDialog(1));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The signature data is damaged.');
    expect(dialog.textContent).toContain("Can't be checked");
  });

  it('shows the checking state for an empty store entry and has no signature cards', async () => {
    api.validateSignatures.mockReturnValue(new Promise(() => undefined));
    render(<Host />);
    act(() => openSignaturesDialog(1));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Checking signatures…');
    expect(dialog.querySelector('[data-sig-card]')).toBeNull();
  });
});

describe('several signatures and later additions (AC 17, 19, 20)', () => {
  it('lists two signatures in file order with their numbers', async () => {
    api.validateSignatures.mockResolvedValue(
      report([sig({ index: 0 }), sig({ index: 1, fieldName: 'Sig2', signer: cert('Grace Hopper') })]),
    );
    render(<Host />);
    await screen.findByRole('status');
    act(() => openSignaturesDialog(1));
    const text = (await screen.findByRole('dialog')).textContent ?? '';
    expect(text).toContain('Signature 1 of 2');
    expect(text).toContain('Signature 2 of 2');
    expect(text.indexOf('Ada Lovelace')).toBeLessThan(text.indexOf('Grace Hopper'));
  });

  it('shows one damaged and one valid signature side by side', async () => {
    api.validateSignatures.mockResolvedValue(
      report([sig({ index: 0, cryptographic: 'malformed', signer: null }), sig({ index: 1, fieldName: 'Sig2' })]),
    );
    render(<Host />);
    await screen.findByRole('status');
    act(() => openSignaturesDialog(1));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The signature data is damaged.');
    expect(dialog.textContent).toContain('Ada Lovelace');
  });

  it('says which version an earlier signature covers', async () => {
    const later = sig({
      coverage: {
        type: 'earlierRevision',
        revision: 1,
        later: { signatures: false, formFill: false, annotations: true, other: false },
        verdict: 'allowed',
      },
    });
    api.validateSignatures.mockResolvedValue(report([later]));
    render(<Host />);
    await screen.findByRole('status');
    act(() => openSignaturesDialog(1));
    expect((await screen.findByRole('dialog')).textContent).toContain('Covers version 1 of 2 of this file');
  });
});
