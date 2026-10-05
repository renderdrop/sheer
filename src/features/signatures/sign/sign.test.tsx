// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaveResult } from '../../../api/save';
import type { SigningIdentityInfo } from '../../../api/signing';
import { useAnnotations } from '../../../stores/annotations';
import { useDocuments } from '../../../stores/documents';
import { resetDocuments } from '../../../stores/documents.testutil';
import { useUi } from '../../../stores/ui';
import { setup } from '../../../test/render';
import { boxAtClick, boxFromDrag, keepInside, nudge } from './geometry';
import { useIdentities } from './identities';
import { SignDialogHost } from './SignDialog';
import { useCertSign } from './store';

const signDocument = vi.fn();
vi.mock('../../../api/signing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/signing')>()),
  signDocument: (...args: unknown[]) => signDocument(...args) as unknown,
}));

const name = { commonName: 'Ada', organization: null, email: null };
const ada: SigningIdentityInfo = {
  id: '1'.repeat(32),
  subject: name,
  issuer: name,
  selfSigned: true,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2029-01-01T00:00:00Z',
  serialHex: '01',
  fingerprintSha256: 'a'.repeat(64),
  source: 'generated',
  key: { type: 'ecP256' },
  chainLength: 1,
  expired: false,
};
const PAGE = [612, 792] as const;

describe('seal geometry', () => {
  it('a click centres the default box and keeps the 12 pt inset', () => {
    expect(boxAtClick({ x: 300, y: 400 }, PAGE)).toEqual({ x: 204, y: 368, w: 192, h: 64 });
    expect(boxAtClick({ x: 0, y: 0 }, PAGE)).toEqual({ x: 12, y: 12, w: 192, h: 64 });
  });
  it('a drag grows to the minimum and stays inside the page', () => {
    expect(boxFromDrag({ x: 100, y: 100 }, { x: 110, y: 105 }, PAGE)).toEqual({ x: 100, y: 100, w: 120, h: 40 });
    expect(boxFromDrag({ x: 600, y: 780 }, { x: 590, y: 770 }, PAGE)).toEqual({ x: 480, y: 740, w: 120, h: 40 });
  });
  it('arrows move by points and never leave the page', () => {
    const rect = { x: 0, y: 0, w: 120, h: 40 };
    expect(nudge(rect, -5, -5, PAGE)).toEqual(rect);
    expect(nudge(rect, 10, 1, PAGE)).toEqual({ x: 10, y: 1, w: 120, h: 40 });
    expect(keepInside({ x: 590, y: 0, w: 120, h: 40 }, PAGE).x).toBe(492);
  });
});

const signed: SaveResult = {
  rev: 1,
  mode: 'incremental',
  backupCreated: false,
  document: { id: 2, pageCount: 3, displayName: 'a - signed.pdf', signatureLock: 'locked' },
  changes: { revision: 0, items: [], history: { canUndo: false, canRedo: false, dirty: false } } as never,
};

function ready() {
  act(() => {
    useIdentities.setState({ status: 'ready', items: [ada] });
    useCertSign.getState().activate(ada.id);
    useCertSign.getState().setBox({ docId: 1, pageIndex: 0, rect: { x: 10, y: 10, w: 192, h: 64 } });
    useCertSign.getState().openDialog();
  });
}

const annotationsInitial = useAnnotations.getState();

beforeEach(() => {
  signDocument.mockReset();
  useAnnotations.setState({ ...annotationsInitial }, true);
  resetDocuments();
  act(() => useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' }));
  useCertSign.getState().reset();
});

describe('the signing flow (DESIGN 3.8 S3)', () => {
  it('shows the plain notice, then signs with the placement, reason and location and opens a new tab', async () => {
    signDocument.mockResolvedValue(signed);
    const { user } = setup(<SignDialogHost />);
    ready();
    expect(await screen.findByText(/not a qualified electronic signature/)).not.toBeNull();
    await user.type(screen.getByLabelText('Reason (optional)'), 'I approve');
    await user.type(screen.getByLabelText('Location (optional)'), 'Berlin');
    await user.click(screen.getByRole('button', { name: 'Sign and save as…' }));
    await waitFor(() => expect(signDocument).toHaveBeenCalled());
    expect(signDocument).toHaveBeenCalledWith(1, {
      identityId: ada.id,
      placement: { pageId: 0, rect: { x: 10, y: 10, w: 192, h: 64 } },
      art: null,
      reason: 'I approve',
      location: 'Berlin',
      lock: 'noChanges',
    });
    await waitFor(() => expect(useDocuments.getState().activeId).toBe(2));
    expect(useDocuments.getState().byId[1]?.displayName).toBe('a.pdf');
    expect(useCertSign.getState().active).toBe(false);
    expect(useUi.getState().toast?.message).toBe('Signed copy saved as a - signed.pdf');
  });

  it('a cancelled save dialog returns to the sheet with nothing changed', async () => {
    signDocument.mockResolvedValue(null);
    const { user } = setup(<SignDialogHost />);
    ready();
    await user.click(await screen.findByRole('button', { name: 'Sign and save as…' }));
    await waitFor(() => expect(signDocument).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Sign and save as…' })).not.toBeNull();
    expect(useDocuments.getState().order).toEqual([1]);
  });

  it.each([
    ['signEncrypted', 'unsupported_feature', 'Password-protected files'],
    ['xfa', 'unsupported_feature', 'Files with XFA forms'],
  ])('shows the backend refusal %s in the sheet and offers to try again', async (what, code, text) => {
    signDocument.mockRejectedValue({ code, message: 'x', params: { what } });
    const { user } = setup(<SignDialogHost />);
    ready();
    await user.click(await screen.findByRole('button', { name: 'Sign and save as…' }));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(useCertSign.getState().dialog).toBe(true);
  });

  it('Cancel closes the sheet and keeps the placeholder', async () => {
    const { user } = setup(<SignDialogHost />);
    ready();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useCertSign.getState()).toMatchObject({ dialog: false, active: true });
    expect(useCertSign.getState().box).not.toBeNull();
  });

  it('an unsaved document cannot be signed from the sheet', async () => {
    useAnnotations.setState((state) => ({ byDoc: { ...state.byDoc, 1: { history: { dirty: true } } } }) as never);
    setup(<SignDialogHost />);
    ready();
    const button = await screen.findByRole('button', { name: 'Sign and save as…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
