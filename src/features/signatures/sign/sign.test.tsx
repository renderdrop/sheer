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
import { boxAtClick, boxFromDrag, keepInside, nudge, resizeBy, resizeTo } from './geometry';
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
    for (const label of ['Reason (optional)', 'Location (optional)']) {
      expect(screen.getByLabelText(label).className).toContain('w-full!');
    }
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

  it('an expired identity cannot sign: the button is off and the date is shown (AC 10)', async () => {
    setup(<SignDialogHost />);
    act(() => {
      useIdentities.setState({ status: 'ready', items: [{ ...ada, expired: true }] });
      useCertSign.getState().activate(ada.id);
      useCertSign.getState().setBox({ docId: 1, pageIndex: 0, rect: { x: 10, y: 10, w: 192, h: 64 } });
      useCertSign.getState().openDialog();
    });
    const button = await screen.findByRole('button', { name: 'Sign and save as…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/2029-01-01/)).not.toBeNull();
    expect(signDocument).not.toHaveBeenCalled();
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

describe('the lock choice (DESIGN 3.8 L1, AC 25 to 27)', () => {
  it('starts at "No changes" for an unsigned file, switches the notice and sends the choice', async () => {
    signDocument.mockResolvedValue(signed);
    const { user } = setup(<SignDialogHost />);
    ready();
    const group = await screen.findByRole('radiogroup', { name: 'Allowed after signing' });
    const none = screen.getByRole('radio', { name: /^No changes/ }) as HTMLInputElement;
    const forms = screen.getByRole('radio', {
      name: /^Fill in forms and allow further signatures/,
    }) as HTMLInputElement;
    expect(group).not.toBeNull();
    expect([none.checked, forms.checked]).toEqual([true, false]);
    expect(none.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.getByText(/can no longer be edited/)).not.toBeNull();
    await user.click(forms);
    expect(screen.getByText(/only form entries and further signatures can be added/)).not.toBeNull();
    expect(screen.queryByText(/can no longer be edited/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign and save as…' }));
    await waitFor(() => expect(signDocument).toHaveBeenCalled());
    expect(signDocument.mock.calls[0]?.[1]).toMatchObject({ lock: 'allowFillAndSign' });
  });

  it('is one tab stop and the arrows move and choose', async () => {
    const { user } = setup(<SignDialogHost />);
    ready();
    const none = (await screen.findByRole('radio', { name: /^No changes/ })) as HTMLInputElement;
    none.focus();
    await user.keyboard('{ArrowDown}');
    expect((screen.getByRole('radio', { name: /^Fill in forms/ }) as HTMLInputElement).checked).toBe(true);
    await user.keyboard('{ArrowUp}');
    expect(none.checked).toBe(true);
  });

  it('never remembers the choice: a new sheet starts at "No changes"', async () => {
    const { user } = setup(<SignDialogHost />);
    ready();
    await user.click(await screen.findByRole('radio', { name: /^Fill in forms/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('radiogroup')).toBeNull());
    act(() => useCertSign.getState().openDialog());
    expect(((await screen.findByRole('radio', { name: /^No changes/ })) as HTMLInputElement).checked).toBe(true);
  });

  it('shows no choice for a signature on an already signed file and signs with "No changes"', async () => {
    signDocument.mockResolvedValue(signed);
    resetDocuments();
    act(() =>
      useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf', flags: { signed: true } as never }),
    );
    const { user } = setup(<SignDialogHost />);
    ready();
    await screen.findByRole('button', { name: 'Sign and save as…' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign and save as…' }));
    await waitFor(() => expect(signDocument).toHaveBeenCalled());
    expect(signDocument.mock.calls[0]?.[1]).toMatchObject({ lock: 'noChanges' });
  });
});

describe('the seal resize geometry (DESIGN 3.8 L6, AC 32)', () => {
  const rect = { x: 100, y: 100, w: 200, h: 80 };
  it('a corner or edge handle moves only its own edges and never goes below the minimum', () => {
    expect(resizeTo(rect, 1, 1, { x: 400, y: 300 }, PAGE)).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    expect(resizeTo(rect, -1, 0, { x: 50, y: 999 }, PAGE)).toEqual({ x: 50, y: 100, w: 250, h: 80 });
    expect(resizeTo(rect, 1, 1, { x: 101, y: 101 }, PAGE)).toEqual({ x: 100, y: 100, w: 120, h: 40 });
    expect(resizeTo(rect, -1, -1, { x: 299, y: 179 }, PAGE)).toEqual({ x: 180, y: 140, w: 120, h: 40 });
  });
  it('stops at the 12 pt inset of the page', () => {
    expect(resizeTo(rect, 1, 1, { x: 9999, y: 9999 }, PAGE)).toEqual({ x: 100, y: 100, w: 500, h: 680 });
    expect(resizeTo(rect, -1, -1, { x: -5, y: -5 }, PAGE)).toEqual({ x: 12, y: 12, w: 288, h: 168 });
  });
  it('the keyboard grows from the bottom-right corner (Right and Down grow, Left and Up shrink)', () => {
    expect(resizeBy(rect, 1, 1, 1, 0, PAGE)).toEqual({ x: 100, y: 100, w: 201, h: 80 });
    expect(resizeBy(rect, 1, 1, 0, 10, PAGE)).toEqual({ x: 100, y: 100, w: 200, h: 90 });
    expect(resizeBy(rect, 1, 1, -100, -100, PAGE)).toEqual({ x: 100, y: 100, w: 120, h: 40 });
  });
});
