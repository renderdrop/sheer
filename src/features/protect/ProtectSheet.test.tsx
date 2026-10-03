// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ProtectSheet } from './ProtectSheet';

const api = vi.hoisted(() => ({
  getProtection: vi.fn(),
  stageProtection: vi.fn(),
  stageUnprotection: vi.fn(),
  PERMISSIONS: ['print', 'copy', 'edit'],
}));
vi.mock('../../api/protection', () => api);

MotionGlobalConfig.skipAnimations = true;

const HISTORY = { canUndo: true, canRedo: false, undoLabel: 'Protect', redoLabel: null, dirty: true };
const changes: ChangeSet = { rev: 2, upserted: [], removed: [], pages: null, history: HISTORY };
const plain = {
  encrypted: false,
  method: 'none',
  ownerRights: true,
  allow: ['print', 'copy', 'edit'],
  pending: 'none',
};

beforeEach(() => {
  useDocuments.setState({
    byId: { 1: { id: 1, pageCount: 2, displayName: 'a.pdf', kind: 'user' } },
    order: [1],
    activeId: 1,
  });
  useAnnotations.setState({ byDoc: {} });
  useUi.setState({ protectOpen: true, toast: null, banner: null });
  api.getProtection.mockReset().mockResolvedValue(plain);
  api.stageProtection.mockReset().mockResolvedValue(changes);
  api.stageUnprotection.mockReset().mockResolvedValue(changes);
});

function Fixture() {
  return (
    <>
      <div id="root" />
      <ProtectSheet />
    </>
  );
}

const apply = () => screen.getByRole('button', { name: 'Protect' });

describe('the Protect sheet', () => {
  it('is closed by default and has Apply soft-disabled until the form is valid', () => {
    useUi.setState({ protectOpen: false });
    setup(<Fixture />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useUi.getState().setProtectOpen(true));
    expect(screen.getByRole('dialog', { name: 'Protect document' })).toBeTruthy();
    expect(apply().getAttribute('aria-disabled')).toBe('true');
  });

  it('stages the open password once, says it takes effect on save, and closes', async () => {
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Require a password to open'));
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    expect(pw.autocomplete).toBe('off');
    await user.type(pw, 'hunter22');
    await user.type(screen.getByLabelText('Confirm password'), 'hunter22');
    await user.click(apply());
    await waitFor(() => expect(api.stageProtection).toHaveBeenCalledTimes(1));
    expect(api.stageProtection).toHaveBeenCalledWith(1, {
      openPassword: 'hunter22',
      permissionsPassword: null,
      allow: ['print', 'copy', 'edit'],
    });
    await waitFor(() => expect(useUi.getState().protectOpen).toBe(false));
    expect(useUi.getState().toast?.message).toBe('Takes effect the next time you save.');
    expect(useAnnotations.getState().byDoc[1]?.history.dirty).toBe(true);
  });

  it('shows a mismatch on blur and keeps Apply disabled', async () => {
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Require a password to open'));
    await user.type(screen.getByLabelText('Password'), 'abc');
    await user.type(screen.getByLabelText('Confirm password'), 'abd');
    await user.tab();
    expect(screen.getByRole('alert').textContent).toContain('match');
    expect(apply().getAttribute('aria-disabled')).toBe('true');
    await user.click(apply());
    expect(api.stageProtection).not.toHaveBeenCalled();
  });

  it('asks for a permissions password that differs when a permission is off', async () => {
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Allow printing'));
    await user.type(screen.getByLabelText('Permissions password'), 'owner1');
    await user.type(screen.getByLabelText('Confirm permissions password'), 'owner1');
    await user.click(screen.getByLabelText('Require a password to open'));
    await user.type(screen.getByLabelText('Password'), 'owner1');
    await user.type(screen.getByLabelText('Confirm password'), 'owner1');
    expect(screen.getByRole('alert').textContent).toContain('Use a different password');
    expect(apply().getAttribute('aria-disabled')).toBe('true');
  });

  it('clears the passwords when the sheet is closed and opened again', async () => {
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Require a password to open'));
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(useUi.getState().protectOpen).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useUi.getState().setProtectOpen(true));
    await user.click(screen.getByLabelText('Require a password to open'));
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(JSON.stringify(useUi.getState())).not.toContain('secret');
  });

  it('removes protection at once with owner rights', async () => {
    api.getProtection.mockResolvedValue({ ...plain, encrypted: true, method: 'aes256' });
    const { user } = setup(<Fixture />);
    await user.click(await screen.findByRole('button', { name: 'Remove protection' }));
    await waitFor(() => expect(api.stageUnprotection).toHaveBeenCalledWith(1, null));
  });

  it('asks for the permissions password without owner rights and shows a wrong one', async () => {
    api.getProtection.mockResolvedValue({ ...plain, encrypted: true, method: 'aes256', ownerRights: false });
    api.stageUnprotection.mockRejectedValue({
      code: 'password_required',
      key: 'error.password_required',
      retryable: false,
    });
    const { user } = setup(<Fixture />);
    await user.click(await screen.findByRole('button', { name: 'Remove protection' }));
    expect(api.stageUnprotection).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Owner password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Remove protection' }));
    expect(await screen.findByText('Wrong permissions password.')).toBeTruthy();
    expect(api.stageUnprotection).toHaveBeenCalledWith(1, 'nope');
    expect(useUi.getState().protectOpen).toBe(true);
    expect((screen.getByLabelText('Owner password') as HTMLInputElement).value).toBe('');
  });

  it('toggles password visibility and switches the toggle label', async () => {
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Require a password to open'));
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    const confirm = screen.getByLabelText('Confirm password') as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: 'Show passwords' }));
    expect(pw.type).toBe('text');
    expect(confirm.type).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Hide passwords' }));
    expect(pw.type).toBe('password');
    expect(screen.queryByRole('button', { name: 'Hide passwords' })).toBeNull();
  });

  it('gives the remove field an owner label and its own show/hide toggle', async () => {
    api.getProtection.mockResolvedValue({ ...plain, encrypted: true, method: 'aes256', ownerRights: false });
    const { user } = setup(<Fixture />);
    await user.click(await screen.findByRole('button', { name: 'Remove protection' }));
    const field = screen.getByLabelText('Owner password') as HTMLInputElement;
    expect(field.type).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show passwords' }));
    expect(field.type).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Hide passwords' }));
    expect(field.type).toBe('password');
  });

  it('shows the strength meter word by password strength', async () => {
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Require a password to open'));
    const meter = screen.getByRole('group', { name: 'Password strength' });
    expect(meter.textContent).toBe('');
    const pw = screen.getByLabelText('Password');
    await user.type(pw, 'abc');
    expect(meter.textContent).toBe('Weak');
    await user.clear(pw);
    await user.type(pw, 'abcdefgh');
    expect(meter.textContent).toBe('Fair');
    await user.clear(pw);
    await user.type(pw, 'Abcdefgh1234');
    expect(meter.textContent).toBe('Strong');
  });

  it('keeps the typed passwords when staging fails with another error', async () => {
    api.stageProtection.mockRejectedValue({ code: 'io', key: 'error.io', retryable: true });
    const { user } = setup(<Fixture />);
    await user.click(screen.getByLabelText('Require a password to open'));
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.type(screen.getByLabelText('Confirm password'), 'hunter22');
    await user.click(apply());
    await waitFor(() => expect(useUi.getState().banner).not.toBeNull());
    expect(useUi.getState().protectOpen).toBe(true);
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('hunter22');
    expect((screen.getByLabelText('Confirm password') as HTMLInputElement).value).toBe('hunter22');
  });
});
