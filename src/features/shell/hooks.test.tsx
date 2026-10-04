// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chromeFor } from '../../lib/platform';
import { RESIZE_SETTLE_MS, useSettledValue, useWindowState } from './hooks';

const windowApi = vi.hoisted(() => ({
  isWindowMaximized: vi.fn(),
  isWindowFullscreen: vi.fn(),
}));

vi.mock('../../api/window', () => windowApi);

const WINDOWS = chromeFor('windows');
const MACOS = chromeFor('macos');
const LINUX = chromeFor('linux');

beforeEach(() => {
  vi.useFakeTimers();
  windowApi.isWindowMaximized.mockReset().mockResolvedValue(false);
  windowApi.isWindowFullscreen.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

const resize = () => window.dispatchEvent(new Event('resize'));

/** Lets the promises of the window API settle without moving the clock. */
const flush = () => act(async () => undefined);

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useWindowState reads the window when a resize has settled, not for every frame of it', () => {
  it('asks once at the start, and once more after a burst of resize events has stopped', async () => {
    renderHook(() => useWindowState(WINDOWS));
    await flush();
    expect(windowApi.isWindowMaximized).toHaveBeenCalledTimes(1);

    // Dragging a window edge: one event per frame for a second.
    for (let frame = 0; frame < 60; frame += 1) {
      resize();
      await advance(16);
    }
    expect(windowApi.isWindowMaximized).toHaveBeenCalledTimes(1);

    await advance(RESIZE_SETTLE_MS);
    expect(windowApi.isWindowMaximized).toHaveBeenCalledTimes(2);
  });

  it('every event of the burst restarts the wait, so a slow drag with pauses shorter than it asks nothing', async () => {
    renderHook(() => useWindowState(WINDOWS));
    await flush();
    windowApi.isWindowMaximized.mockClear();
    for (let step = 0; step < 10; step += 1) {
      resize();
      await advance(RESIZE_SETTLE_MS - 1);
    }
    expect(windowApi.isWindowMaximized).not.toHaveBeenCalled();
    await advance(1);
    expect(windowApi.isWindowMaximized).toHaveBeenCalledTimes(1);
  });

  it('shows the state that the settled read answers: a window that was maximized by dragging it to the edge', async () => {
    const { result } = renderHook(() => useWindowState(WINDOWS));
    await flush();
    expect(result.current.maximized).toBe(false);
    windowApi.isWindowMaximized.mockResolvedValue(true);
    resize();
    // Not yet: the answer is read once the resize is over.
    await advance(RESIZE_SETTLE_MS - 1);
    expect(result.current.maximized).toBe(false);
    await advance(1);
    expect(result.current.maximized).toBe(true);
  });

  it('a read that is asked for by hand (a caption button) is not delayed', async () => {
    const { result } = renderHook(() => useWindowState(WINDOWS));
    await flush();
    windowApi.isWindowMaximized.mockResolvedValue(true);
    act(() => result.current.refresh());
    await flush();
    expect(result.current.maximized).toBe(true);
  });

  it('a pending read does not run after the component is gone, and the listener is removed', async () => {
    const { unmount } = renderHook(() => useWindowState(WINDOWS));
    await flush();
    windowApi.isWindowMaximized.mockClear();
    resize();
    unmount();
    await advance(RESIZE_SETTLE_MS * 2);
    expect(windowApi.isWindowMaximized).not.toHaveBeenCalled();
    resize();
    await advance(RESIZE_SETTLE_MS * 2);
    expect(windowApi.isWindowMaximized).not.toHaveBeenCalled();
  });

  it('asks only for what the platform needs: macOS the full screen state, Windows both, others nothing', async () => {
    const mac = renderHook(() => useWindowState(MACOS));
    await flush();
    resize();
    await advance(RESIZE_SETTLE_MS);
    expect(windowApi.isWindowFullscreen).toHaveBeenCalledTimes(2);
    expect(windowApi.isWindowMaximized).not.toHaveBeenCalled();
    mac.unmount();

    windowApi.isWindowFullscreen.mockClear();
    const windows = renderHook(() => useWindowState(WINDOWS));
    await flush();
    resize();
    await advance(RESIZE_SETTLE_MS);
    expect(windowApi.isWindowMaximized).toHaveBeenCalledTimes(2);
    expect(windowApi.isWindowFullscreen).toHaveBeenCalledTimes(2);
    windows.unmount();

    windowApi.isWindowMaximized.mockClear();
    windowApi.isWindowFullscreen.mockClear();
    renderHook(() => useWindowState(LINUX));
    await flush();
    resize();
    await advance(RESIZE_SETTLE_MS);
    expect(windowApi.isWindowMaximized).not.toHaveBeenCalled();
    expect(windowApi.isWindowFullscreen).not.toHaveBeenCalled();
  });

  it('a failing read counts as "no" and the next settled resize asks again', async () => {
    windowApi.isWindowMaximized.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    const { result } = renderHook(() => useWindowState(WINDOWS));
    await flush();
    expect(result.current.maximized).toBe(false);
    windowApi.isWindowMaximized.mockResolvedValue(true);
    resize();
    await advance(RESIZE_SETTLE_MS);
    expect(result.current.maximized).toBe(true);
  });
});

describe('useSettledValue', () => {
  it('follows the value only after it has stopped changing for the delay', async () => {
    const { result, rerender } = renderHook(({ value }) => useSettledValue(value, 500), { initialProps: { value: 1 } });
    expect(result.current).toBe(1);
    for (const value of [2, 3, 4]) {
      rerender({ value });
      await advance(499);
      expect(result.current).toBe(1);
    }
    await advance(1);
    expect(result.current).toBe(4);
  });
});
