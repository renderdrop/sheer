// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppBootstrap, AppEvent, Settings } from './api/app';
import { APP_NAME } from './config/app';

/**
 * The window entry point, run for real: `main.tsx` is imported into a page that has a `#root`, with the backend calls
 * stubbed. What matters is that the window never depends on the backend answering (ORCHESTRATOR_PROMPT 8.3).
 */
const backend = vi.hoisted(() => ({
  appReady: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  watchTransparency: vi.fn(),
  subscribeMenu: vi.fn(),
  subscribeApp: vi.fn(),
}));

vi.mock('./api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/app')>()),
  appReady: backend.appReady,
  getSettings: backend.getSettings,
  updateSettings: backend.updateSettings,
  watchTransparency: backend.watchTransparency,
  subscribeMenu: backend.subscribeMenu,
  subscribeApp: backend.subscribeApp,
}));
vi.mock('./App', async () => {
  const { createElement } = await import('react');
  return { App: () => createElement('p', null, 'App is on screen') };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const bootstrap: AppBootstrap = { platform: 'macos', reducedTransparency: false, version: '0.2.0' };
const root = () => document.getElementById('root');
const html = document.documentElement;
const settingsStore = async () => (await import('./stores/settings')).useSettings;
const start = () =>
  act(async () => {
    await import('./main');
  });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  document.body.replaceChildren();
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  document.title = '';
  html.removeAttribute('data-theme');
  html.removeAttribute('data-transparency');
  // Every backend call hangs until a test says otherwise.
  backend.appReady.mockReset().mockReturnValue(new Promise(() => undefined));
  backend.getSettings.mockReset().mockReturnValue(new Promise(() => undefined));
  backend.updateSettings.mockReset().mockReturnValue(new Promise(() => undefined));
  backend.watchTransparency.mockReset().mockReturnValue(new Promise(() => undefined));
  backend.subscribeMenu.mockReset().mockReturnValue(new Promise(() => undefined));
  backend.subscribeApp.mockReset().mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  vi.useRealTimers();
  html.removeAttribute('data-theme');
  html.removeAttribute('data-transparency');
});

describe('main.tsx while the settings load hangs', () => {
  it('renders the app at once with the defaults, without waiting for the backend', async () => {
    await start();
    expect(root()?.textContent).toBe('App is on screen');
    expect(document.title).toBe(APP_NAME);
    expect(html.hasAttribute('data-theme')).toBe(false);
    expect(html.hasAttribute('data-transparency')).toBe(false);
    expect(backend.appReady).toHaveBeenCalledTimes(1);
    expect(backend.getSettings).toHaveBeenCalledTimes(1);
    const store = await settingsStore();
    expect(store.getState()).toMatchObject({ glass: 'auto', theme: 'system', loaded: false, error: null });
  });

  it('gives up waiting after a few seconds: defaults stay, the window stays, the error is recorded', async () => {
    await start();
    await wait(2999);
    const store = await settingsStore();
    expect(store.getState().loaded).toBe(false);
    await wait(1);
    expect(store.getState()).toMatchObject({ glass: 'auto', theme: 'system', loaded: true });
    expect(store.getState().error).not.toBeNull();
    expect(root()?.textContent).toBe('App is on screen');
    expect(html.hasAttribute('data-theme')).toBe(false);
    expect(html.hasAttribute('data-transparency')).toBe(false);
  });

  it('applies the saved settings to <html> when they arrive late, after the timeout', async () => {
    const boot = deferred<AppBootstrap>();
    const saved = deferred<Settings>();
    backend.appReady.mockReturnValue(boot.promise);
    backend.getSettings.mockReturnValue(saved.promise);
    await start();
    await wait(5000);
    expect(html.hasAttribute('data-theme')).toBe(false);
    await act(async () => {
      boot.resolve(bootstrap);
      saved.resolve({ glass: 'solid', theme: 'dark', language: 'system', leftPanelWidth: 248, welcomeTour: 'pending' });
    });
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(html.getAttribute('data-transparency')).toBe('reduced');
    expect((await settingsStore()).getState().error).toBeNull();
    expect(root()?.textContent).toBe('App is on screen');
  });

  it('applies the saved settings at once when the backend answers in time, without an error', async () => {
    backend.appReady.mockResolvedValue(bootstrap);
    backend.getSettings.mockResolvedValue({ glass: 'auto', theme: 'light', language: 'system', leftPanelWidth: 248 });
    await start();
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(html.hasAttribute('data-transparency')).toBe(false);
    const store = await settingsStore();
    expect(store.getState()).toMatchObject({ loaded: true, error: null, platform: 'macos' });
    await wait(10_000);
    expect(store.getState().error).toBeNull();
  });

  it('gives the left panel the saved width, and saves a width the user chooses', async () => {
    backend.appReady.mockResolvedValue(bootstrap);
    backend.getSettings.mockResolvedValue({ glass: 'auto', theme: 'system', language: 'system', leftPanelWidth: 320 });
    backend.updateSettings.mockImplementation((patch: object) =>
      Promise.resolve({ glass: 'auto', theme: 'system', language: 'system', leftPanelWidth: 320, ...patch }),
    );
    await start();
    const { useUi } = await import('./stores/ui');
    expect(useUi.getState().leftPanelWidth).toBe(320);
    act(() => useUi.getState().setLeftPanelWidth(352));
    await wait(1000);
    expect(backend.updateSettings).toHaveBeenCalledTimes(1);
    expect(backend.updateSettings).toHaveBeenCalledWith({ leftPanelWidth: 352 });
  });

  it('keeps the window and the defaults when the backend refuses', async () => {
    backend.appReady.mockRejectedValue(new Error('no backend'));
    backend.getSettings.mockRejectedValue(new Error('no backend'));
    await start();
    expect(root()?.textContent).toBe('App is on screen');
    const store = await settingsStore();
    expect(store.getState()).toMatchObject({ glass: 'auto', theme: 'system', loaded: true });
    expect(store.getState().error).not.toBeNull();
    expect(html.hasAttribute('data-theme')).toBe(false);
  });

  it('watches OS transparency changes without waiting for the channel to be opened', async () => {
    await start();
    expect(backend.watchTransparency).toHaveBeenCalledTimes(1);
    expect(root()?.textContent).toBe('App is on screen');
  });

  it('applies what the OS transparency channel carries to <html>', async () => {
    backend.appReady.mockResolvedValue(bootstrap);
    backend.getSettings.mockResolvedValue({ glass: 'auto', theme: 'system', language: 'system', leftPanelWidth: 248 });
    let send: ((reduced: boolean) => void) | undefined;
    backend.watchTransparency.mockImplementation((onChange: (reduced: boolean) => void) => {
      send = onChange;
      return Promise.resolve();
    });
    await start();
    expect(html.hasAttribute('data-transparency')).toBe(false);
    act(() => send?.(true));
    expect(html.getAttribute('data-transparency')).toBe('reduced');
    act(() => send?.(false));
    expect(html.hasAttribute('data-transparency')).toBe(false);
  });

  it('subscribes to the native menu without waiting for the channel, and runs the actions it names', async () => {
    let choose: ((id: string) => void) | undefined;
    backend.subscribeMenu.mockImplementation((onAction: (id: string) => void) => {
      choose = onAction;
      return new Promise(() => undefined);
    });
    await start();
    expect(backend.subscribeMenu).toHaveBeenCalledTimes(1);
    expect(backend.subscribeMenu).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
    expect(root()?.textContent).toBe('App is on screen');
    // A menu command goes through the registry: with no document open, "Close Document" does nothing, and an unknown id too.
    const { useViewer } = await import('./features/viewer/useViewer');
    const before = useViewer.getState();
    act(() => choose?.('close-document'));
    act(() => choose?.('not-an-action'));
    expect(useViewer.getState()).toBe(before);
  });

  it('keeps the window when the native menu cannot be subscribed to', async () => {
    backend.subscribeMenu.mockRejectedValue(new Error('no backend'));
    await start();
    expect(root()?.textContent).toBe('App is on screen');
  });

  it('subscribes to what the backend pushes without waiting for the channel, and acts on it', async () => {
    let push: ((event: AppEvent) => void) | undefined;
    backend.subscribeApp.mockImplementation((onEvent: (event: AppEvent) => void) => {
      push = onEvent;
      return new Promise(() => undefined);
    });
    await start();
    expect(backend.subscribeApp).toHaveBeenCalledTimes(1);
    expect(backend.subscribeApp).toHaveBeenCalledWith(expect.any(Function));
    expect(root()?.textContent).toBe('App is on screen');

    // A drag over the window, and a file opened by the OS: the first result may even have come before the window listened.
    const { useUi } = await import('./stores/ui');
    const { useDocuments } = await import('./stores/documents');
    act(() => push?.({ type: 'dropHover', active: true }));
    expect(useUi.getState().dropHover).toBe(true);
    act(() => push?.({ type: 'dropHover', active: false }));
    expect(useUi.getState().dropHover).toBe(false);
    act(() => push?.({ type: 'opened', document: { id: 7, pageCount: 2, displayName: 'Started with.pdf' } }));
    expect(useDocuments.getState().activeId).toBe(7);
  });

  it('keeps the window when what the backend pushes cannot be subscribed to', async () => {
    backend.subscribeApp.mockRejectedValue(new Error('no backend'));
    await start();
    expect(root()?.textContent).toBe('App is on screen');
  });

  it('fails loudly, and does not start loading, when the page has no #root', async () => {
    root()?.remove();
    await expect(import('./main')).rejects.toThrow('Missing #root element');
    expect(backend.appReady).not.toHaveBeenCalled();
  });
});
