// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { CaptionBar } from './CaptionBar';

const windowApi = vi.hoisted(() => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
}));

vi.mock('../../api/window', () => windowApi);

beforeEach(() => {
  for (const mock of Object.values(windowApi)) mock.mockReset().mockResolvedValue(undefined);
});

const flush = () => act(async () => undefined);

describe('CaptionBar (DESIGN 2.2, Windows)', () => {
  it('shows three named caption buttons and no menu bar', () => {
    setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    expect(screen.queryByRole('menubar')).toBeNull();
    const group = screen.getByRole('group', { name: 'Window controls' });
    expect([...group.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Minimize',
      'Maximize',
      'Close',
    ]);
  });

  it('the buttons call the window API: minimize, toggle maximize, close', async () => {
    const { user } = setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(windowApi.minimizeWindow).toHaveBeenCalledTimes(1);
    expect(windowApi.toggleMaximizeWindow).not.toHaveBeenCalled();
    expect(windowApi.closeWindow).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(windowApi.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(windowApi.closeWindow).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('a maximized window offers Restore instead of Maximize, with the other icon', () => {
    const { rerender } = setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    const glyph = () =>
      screen
        .getByRole('button', { name: /^(Maximize|Restore)$/ })
        .querySelector('svg')
        ?.getAttribute('class');
    const maximizeGlyph = glyph();
    rerender(<CaptionBar maximized onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Restore' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Maximize' })).toBeNull();
    expect(glyph()).not.toBe(maximizeGlyph);
  });

  it('asks for the window state again after a button acted, also when the action failed', async () => {
    const onChanged = vi.fn();
    const { user } = setup(<CaptionBar maximized={false} onChanged={onChanged} />);
    await user.click(screen.getByRole('button', { name: 'Maximize' }));
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Outside Tauri, or with the permission missing, the call rejects: nothing happens, nothing throws.
    windowApi.minimizeWindow.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('is no drag region itself (the strip around it is), and its buttons are not (a click on a button must not start a drag)', () => {
    const { container } = setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    expect(container.firstElementChild?.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(container.querySelector('button')?.hasAttribute('data-tauri-drag-region')).toBe(false);
  });

  it('the buttons are not tab stops (a native caption has none)', () => {
    setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    for (const button of screen.getAllByRole('button')) expect(button.tabIndex).toBe(-1);
  });

  it('the close button is red on hover and press with a white glyph; the others use the control hover colors', () => {
    setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain('hover:bg-win-close');
    expect(close.className).toContain('hover:text-on-close');
    expect(screen.getByRole('button', { name: 'Minimize' }).className).toContain('hover:bg-control-hover');
  });

  it('the buttons are 46 wide and as high as the 56 strip through the layout tokens', () => {
    setup(<CaptionBar maximized={false} onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('w-caption-button');
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('h-full');
  });
});
