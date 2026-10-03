// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { TOAST_ACTION_MS, TOAST_MS, ToastLayer } from './Toast';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useUi.setState({ toast: null });
});
afterEach(() => {
  vi.useRealTimers();
  useUi.setState({ toast: null });
});

describe('the toast (DESIGN 3.12)', () => {
  it('is a status that never takes focus, and goes after 4 s', async () => {
    setup(<ToastLayer />, { advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
    act(() => useUi.getState().showToast({ message: 'Saved' }));
    expect(screen.getByRole('status').textContent).toBe('Saved');
    expect(document.querySelector('[data-toast]')?.textContent).toContain('Saved');
    expect(document.activeElement).toBe(document.body);
    act(() => void vi.advanceTimersByTime(TOAST_MS + 1));
    expect(useUi.getState().toast).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-toast]')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('stays 8 s with an action, and the action runs once and closes it', async () => {
    const run = vi.fn();
    const { user } = setup(<ToastLayer />, { advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
    act(() => useUi.getState().showToast({ message: 'Removed', action: { label: 'Undo', run } }));
    act(() => void vi.advanceTimersByTime(TOAST_MS + 1));
    expect(useUi.getState().toast).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(useUi.getState().toast).toBeNull();
    expect(TOAST_ACTION_MS).toBeGreaterThan(TOAST_MS);
  });

  it('pauses while the pointer is over it and a newer toast replaces the older one', async () => {
    const { user } = setup(<ToastLayer />, { advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
    act(() => useUi.getState().showToast({ message: 'One' }));
    await user.hover(document.querySelector<HTMLElement>('[data-toast]')!);
    act(() => void vi.advanceTimersByTime(TOAST_MS * 3));
    expect(useUi.getState().toast?.message).toBe('One');
    act(() => useUi.getState().showToast({ message: 'Two' }));
    const first = useUi.getState().toast?.id ?? 0;
    act(() => useUi.getState().dismissToast(first - 1));
    expect(useUi.getState().toast?.message).toBe('Two');
  });
});
