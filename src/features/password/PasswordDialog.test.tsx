// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { useUi } from '../../stores/ui';
import { PasswordDialog } from './PasswordDialog';
import { requestPassword, usePassword } from './state';

const api = vi.hoisted(() => ({
  unlockDocument: vi.fn(),
  closeDocument: vi.fn(),
  MAX_PASSWORD_BYTES: 1024,
}));
const adopt = vi.hoisted(() => vi.fn());

vi.mock('../../api/documents', () => api);
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: adopt }));

MotionGlobalConfig.skipAnimations = true;

const wrongPassword = { code: 'password_required', key: 'error.password_required', retryable: false };

beforeEach(() => {
  usePassword.setState({ queue: [] });
  api.unlockDocument.mockReset();
  api.closeDocument.mockReset().mockResolvedValue(undefined);
  adopt.mockReset();
  useUi.getState().dismissBanner();
});

function Fixture() {
  return (
    <>
      <div id="root">
        <button type="button">behind</button>
      </div>
      <PasswordDialog />
    </>
  );
}

const field = () => screen.getByLabelText('Password') as HTMLInputElement;

describe('the password prompt', () => {
  it('is closed until a document asks, then names the file and focuses the field', () => {
    setup(<Fixture />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => requestPassword(4, 'Secret.pdf'));
    const dialog = screen.getByRole('dialog', { name: 'Password required' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('"Secret.pdf" is protected.');
    expect(field().type).toBe('password');
    expect(field().autocomplete).toBe('off');
    expect(document.activeElement).toBe(field());
  });

  it('keeps Open disabled while the field is empty and the eye shows the password', async () => {
    const { user } = setup(<Fixture />);
    act(() => requestPassword(4, 'A.pdf'));
    expect(screen.getByRole('button', { name: 'Open' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field().type).toBe('text');
    expect(screen.getByRole('button', { name: 'Show password' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('sends the password once per attempt, opens the document and clears the prompt', async () => {
    const info = { id: 4, pageCount: 2, displayName: 'A.pdf' };
    api.unlockDocument.mockResolvedValue(info);
    const { user } = setup(<Fixture />);
    act(() => requestPassword(4, 'A.pdf'));
    await user.type(field(), 'hunter2{Enter}');
    expect(api.unlockDocument).toHaveBeenCalledExactlyOnceWith(4, 'hunter2');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adopt).toHaveBeenCalledWith([{ type: 'opened', document: info }]);
    expect(api.closeDocument).not.toHaveBeenCalled();
  });

  it('a wrong password says so as an alert, marks the field and stays', async () => {
    api.unlockDocument.mockRejectedValue(wrongPassword);
    const { user } = setup(<Fixture />);
    act(() => requestPassword(4, 'A.pdf'));
    await user.type(field(), 'nope{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Wrong password. Try again.');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog')).not.toBeNull();
    // Typing again takes the message away.
    await user.type(field(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('any other failure closes the prompt and puts the error in the banner', async () => {
    api.unlockDocument.mockRejectedValue({ code: 'damaged_file', key: 'error.damaged_file', retryable: false });
    const { user } = setup(<Fixture />);
    act(() => requestPassword(4, 'A.pdf'));
    await user.type(field(), 'pw{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useUi.getState().banner?.code).toBe('damaged_file');
  });

  it('Escape and Cancel close the prompt and tell the backend to forget the document', async () => {
    const { user } = setup(<Fixture />);
    act(() => requestPassword(4, 'A.pdf'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.closeDocument).toHaveBeenCalledExactlyOnceWith(4);
    act(() => requestPassword(5, 'B.pdf'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.closeDocument).toHaveBeenLastCalledWith(5);
  });

  it('asks for several files one after the other, in order, and a file asked twice once', () => {
    setup(<Fixture />);
    act(() => {
      requestPassword(1, 'One.pdf');
      requestPassword(2, 'Two.pdf');
      requestPassword(1, 'One.pdf');
    });
    expect(usePassword.getState().queue.map((item) => item.id)).toEqual([1, 2]);
    expect(screen.getByRole('dialog').textContent).toContain('One.pdf');
  });
});
