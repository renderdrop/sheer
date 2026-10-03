import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '../../stores/ui';
import { clearRenderFailure, showRenderFailure } from './renderFailure';
import { publishViewRect, readScroll, readViewRect, registerScrollSource, subscribeViewRect } from './scrollBridge';

describe('the scroll bridge', () => {
  it('is the origin until a canvas registers, and what the canvas says while it is mounted', () => {
    expect(readScroll()).toEqual({ left: 0, top: 0 });
    const stop = registerScrollSource(() => ({ left: 3, top: 400 }));
    expect(readScroll()).toEqual({ left: 3, top: 400 });
    stop();
    expect(readScroll()).toEqual({ left: 0, top: 0 });
  });

  it('is read each time, not copied when it registers', () => {
    let top = 10;
    const stop = registerScrollSource(() => ({ left: 0, top }));
    expect(readScroll().top).toBe(10);
    top = 20;
    expect(readScroll().top).toBe(20);
    stop();
  });

  it('is not taken away from a canvas that replaced the one that is going', () => {
    const first = registerScrollSource(() => ({ left: 1, top: 1 }));
    const second = registerScrollSource(() => ({ left: 2, top: 2 }));
    first();
    expect(readScroll()).toEqual({ left: 2, top: 2 });
    second();
    expect(readScroll()).toEqual({ left: 0, top: 0 });
  });
});

describe('the view rectangle', () => {
  afterEach(() => publishViewRect({ left: 0, top: 0, right: 0, bottom: 0 }));

  it('tells the listeners when it changes, and not when it is published again unchanged', () => {
    const listener = vi.fn();
    const stop = subscribeViewRect(listener);
    publishViewRect({ left: 0, top: 10, right: 800, bottom: 710 });
    publishViewRect({ left: 0, top: 10, right: 800, bottom: 710 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readViewRect()).toEqual({ left: 0, top: 10, right: 800, bottom: 710 });
    publishViewRect({ left: 0, top: 20, right: 800, bottom: 720 });
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    publishViewRect({ left: 0, top: 30, right: 800, bottom: 730 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('the render failure banner', () => {
  const uiInitial = useUi.getState();
  const timeout = { code: 'engine_timeout', key: 'error.engine_timeout', retryable: true } as const;
  const crashed = { code: 'engine_crashed', key: 'error.engine_crashed', retryable: false } as const;

  beforeEach(() => useUi.setState({ ...uiInitial }, true));
  afterEach(() => {
    clearRenderFailure();
    useUi.setState({ ...uiInitial }, true);
  });

  it('shows the error, and a failure of the same kind does not replace it', () => {
    showRenderFailure(timeout);
    expect(useUi.getState().banner).toBe(timeout);
    showRenderFailure({ ...timeout });
    expect(useUi.getState().banner).toBe(timeout);
    showRenderFailure(crashed);
    expect(useUi.getState().banner).toBe(crashed);
  });

  it('is cleared by a render that works, but only when it is still the banner', () => {
    showRenderFailure(timeout);
    clearRenderFailure();
    expect(useUi.getState().banner).toBeNull();

    showRenderFailure(timeout);
    const other = { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false } as const;
    useUi.getState().showBanner(other);
    clearRenderFailure();
    expect(useUi.getState().banner).toBe(other);
  });

  it('does nothing to a banner that is not its own, and a clear without a failure is nothing', () => {
    const other = { code: 'io_not_found', key: 'error.io_not_found', retryable: false } as const;
    useUi.getState().showBanner(other);
    clearRenderFailure();
    expect(useUi.getState().banner).toBe(other);
    // A failure of the same code as one that another error replaced is shown again.
    showRenderFailure(timeout);
    useUi.getState().showBanner(other);
    showRenderFailure({ ...timeout });
    expect(useUi.getState().banner).toMatchObject({ code: 'engine_timeout' });
  });
});
