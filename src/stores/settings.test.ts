import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GLASS_MODES,
  THEME_MODES,
  appReady,
  getSettings,
  updateSettings,
  type AppBootstrap,
  type Settings,
} from '../api/app';
import {
  SETTINGS_LOAD_TIMEOUT_MS,
  applySettings,
  bindSettingsToRoot,
  loadSettings,
  themeAttribute,
  transparencyAttribute,
  useSettings,
  watchOsTransparency,
  type AttributeTarget,
} from './settings';

vi.mock('../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/app')>()),
  appReady: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const appReadyMock = vi.mocked(appReady);
const getSettingsMock = vi.mocked(getSettings);
const updateSettingsMock = vi.mocked(updateSettings);

/** Stands in for `<html>`: records attributes the way the DOM would. */
class FakeRoot implements AttributeTarget {
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.attributes);
  }
}

const bootstrap = (overrides: Partial<AppBootstrap> = {}): AppBootstrap => ({
  platform: 'windows',
  reducedTransparency: false,
  version: '0.2.0',
  ...overrides,
});

const INTERNAL = { code: 'internal', key: 'error.internal', retryable: false };

beforeEach(() => {
  vi.resetAllMocks();
  useSettings.setState(useSettings.getInitialState(), true);
});

describe('attribute rules', () => {
  it('data-theme is absent for "system" so the OS decides, and explicit otherwise', () => {
    expect(themeAttribute({ theme: 'system' })).toBeNull();
    expect(themeAttribute({ theme: 'light' })).toBe('light');
    expect(themeAttribute({ theme: 'dark' })).toBe('dark');
  });

  it('data-transparency is "reduced" for Glass: Solid or the OS flag, absent otherwise', () => {
    expect(transparencyAttribute({ glass: 'auto', osReducedTransparency: false })).toBeNull();
    expect(transparencyAttribute({ glass: 'solid', osReducedTransparency: false })).toBe('reduced');
    expect(transparencyAttribute({ glass: 'auto', osReducedTransparency: true })).toBe('reduced');
    expect(transparencyAttribute({ glass: 'solid', osReducedTransparency: true })).toBe('reduced');
  });

  it('applySettings sets and clears both attributes on the element', () => {
    const root = new FakeRoot();
    applySettings(root, { theme: 'dark', glass: 'solid', osReducedTransparency: false });
    expect(root.snapshot()).toEqual({ 'data-theme': 'dark', 'data-transparency': 'reduced' });
    applySettings(root, { theme: 'system', glass: 'auto', osReducedTransparency: false });
    expect(root.snapshot()).toEqual({});
  });
});

describe('store to <html> attributes', () => {
  it('starts with no attributes: follow the OS, glass on', () => {
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    expect(root.snapshot()).toEqual({});
  });

  it('applies the current state as soon as it is bound', () => {
    useSettings.setState({ theme: 'light', glass: 'solid' });
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    expect(root.snapshot()).toEqual({ 'data-theme': 'light', 'data-transparency': 'reduced' });
  });

  it('follows the theme setting through every value', async () => {
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    for (const theme of ['dark', 'light', 'system'] as const) {
      updateSettingsMock.mockResolvedValueOnce({ glass: 'auto', theme, leftPanelWidth: 248 });
      await useSettings.getState().setTheme(theme);
      expect(root.attributes.get('data-theme')).toBe(theme === 'system' ? undefined : theme);
    }
    expect(updateSettingsMock.mock.calls).toEqual([[{ theme: 'dark' }], [{ theme: 'light' }], [{ theme: 'system' }]]);
  });

  it('follows the glass setting: Solid reduces transparency, Auto clears it', async () => {
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    updateSettingsMock.mockResolvedValueOnce({ glass: 'solid', theme: 'system', leftPanelWidth: 248 });
    await useSettings.getState().setGlass('solid');
    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
    updateSettingsMock.mockResolvedValueOnce({ glass: 'auto', theme: 'system', leftPanelWidth: 248 });
    await useSettings.getState().setGlass('auto');
    expect(root.snapshot()).toEqual({});
  });

  it('keeps data-transparency while the OS flag is on, even with Glass: Auto', async () => {
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos', reducedTransparency: true }));
    getSettingsMock.mockResolvedValue({ glass: 'auto', theme: 'system', leftPanelWidth: 248 });
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    await useSettings.getState().load();
    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
    updateSettingsMock.mockResolvedValueOnce({ glass: 'solid', theme: 'system', leftPanelWidth: 248 });
    await useSettings.getState().setGlass('solid');
    updateSettingsMock.mockResolvedValueOnce({ glass: 'auto', theme: 'system', leftPanelWidth: 248 });
    await useSettings.getState().setGlass('auto');
    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
  });

  it('stops updating the element after unbinding', async () => {
    const root = new FakeRoot();
    const unbind = bindSettingsToRoot(root);
    unbind();
    updateSettingsMock.mockResolvedValueOnce({ glass: 'auto', theme: 'dark', leftPanelWidth: 248 });
    await useSettings.getState().setTheme('dark');
    expect(root.snapshot()).toEqual({});
  });
});

describe('load', () => {
  it('mirrors the stored settings and the bootstrap report, and applies them', async () => {
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos', reducedTransparency: true, version: '1.2.3' }));
    getSettingsMock.mockResolvedValue({ glass: 'solid', theme: 'dark', leftPanelWidth: 248 });
    const root = new FakeRoot();
    bindSettingsToRoot(root);

    await useSettings.getState().load();

    expect(useSettings.getState()).toMatchObject({
      glass: 'solid',
      theme: 'dark',
      osReducedTransparency: true,
      platform: 'macos',
      version: '1.2.3',
      loaded: true,
      error: null,
    });
    expect(root.snapshot()).toEqual({ 'data-theme': 'dark', 'data-transparency': 'reduced' });
  });

  it('keeps the defaults and records the error when the backend does not answer', async () => {
    appReadyMock.mockRejectedValue(INTERNAL);
    getSettingsMock.mockRejectedValue(INTERNAL);
    const root = new FakeRoot();
    bindSettingsToRoot(root);

    await expect(useSettings.getState().load()).resolves.toBeUndefined();

    expect(useSettings.getState()).toMatchObject({ glass: 'auto', theme: 'system', loaded: true });
    expect(useSettings.getState().error).toMatchObject({ code: 'internal' });
    expect(root.snapshot()).toEqual({});
  });

  it('uses what did arrive when only one of the two calls fails', async () => {
    appReadyMock.mockRejectedValue(INTERNAL);
    getSettingsMock.mockResolvedValue({ glass: 'auto', theme: 'light', leftPanelWidth: 248 });
    await useSettings.getState().load();
    expect(useSettings.getState()).toMatchObject({ theme: 'light', platform: null, loaded: true });
    expect(useSettings.getState().error).not.toBeNull();
  });
});

describe('update', () => {
  it('leaves state and attributes alone when the backend rejects the change', async () => {
    useSettings.setState({ theme: 'dark' });
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    updateSettingsMock.mockRejectedValueOnce({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'settings' },
    });

    await expect(useSettings.getState().setTheme('light')).resolves.toBeUndefined();

    expect(useSettings.getState().theme).toBe('dark');
    expect(useSettings.getState().error).toMatchObject({ code: 'invalid_argument', params: { what: 'settings' } });
    expect(root.snapshot()).toEqual({ 'data-theme': 'dark' });
  });

  it('clears the error after the next success', async () => {
    useSettings.setState({ error: { code: 'internal', key: 'error.internal', retryable: false } });
    updateSettingsMock.mockResolvedValueOnce({ glass: 'auto', theme: 'light', leftPanelWidth: 248 });
    await useSettings.getState().setTheme('light');
    expect(useSettings.getState().error).toBeNull();
  });

  it('applies what the backend answers, not what was asked', async () => {
    updateSettingsMock.mockResolvedValueOnce({ glass: 'solid', theme: 'dark', leftPanelWidth: 248 });
    await useSettings.getState().setTheme('dark');
    expect(useSettings.getState()).toMatchObject({ glass: 'solid', theme: 'dark', leftPanelWidth: 248 });
  });

  it('ignores a slow answer that arrives after a newer one', async () => {
    const resolvers: Array<(settings: Settings) => void> = [];
    updateSettingsMock.mockImplementation(
      () =>
        new Promise<Settings>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const root = new FakeRoot();
    bindSettingsToRoot(root);

    const first = useSettings.getState().setTheme('dark');
    const second = useSettings.getState().setTheme('light');
    resolvers[1]?.({ glass: 'auto', theme: 'light', leftPanelWidth: 248 });
    await second;
    resolvers[0]?.({ glass: 'auto', theme: 'dark', leftPanelWidth: 248 });
    await first;

    expect(useSettings.getState().theme).toBe('light');
    expect(root.snapshot()).toEqual({ 'data-theme': 'light' });
  });
});

describe('attribute truth table', () => {
  const OS_FLAGS = [false, true] as const;

  it('writes exactly the documented attributes for every combination, and removes stale ones', () => {
    for (const theme of THEME_MODES) {
      for (const glass of GLASS_MODES) {
        for (const osReducedTransparency of OS_FLAGS) {
          const root = new FakeRoot();
          // Left over from an earlier state: must disappear when they no longer apply.
          root.setAttribute('data-theme', 'dark');
          root.setAttribute('data-transparency', 'reduced');

          applySettings(root, { theme, glass, osReducedTransparency });

          const expected: Record<string, string> = {};
          if (theme !== 'system') expected['data-theme'] = theme;
          if (glass === 'solid' || osReducedTransparency) expected['data-transparency'] = 'reduced';
          expect(root.snapshot(), `${theme} / ${glass} / os=${String(osReducedTransparency)}`).toEqual(expected);
        }
      }
    }
  });

  it('never writes any other attribute name or value', () => {
    const written: Array<[string, string]> = [];
    const spy: AttributeTarget = {
      setAttribute: (name, value) => written.push([name, value]),
      removeAttribute: (name) => written.push([name, '<removed>']),
    };
    for (const theme of THEME_MODES) {
      for (const glass of GLASS_MODES) {
        for (const osReducedTransparency of OS_FLAGS) applySettings(spy, { theme, glass, osReducedTransparency });
      }
    }
    for (const [name, value] of written) {
      expect(['data-theme', 'data-transparency']).toContain(name);
      expect(['light', 'dark', 'reduced', '<removed>']).toContain(value);
    }
    // "system" is never written as an attribute value: the attribute is removed instead.
    expect(written.some(([, value]) => value === 'system')).toBe(false);
  });

  it('theme and transparency are independent of each other', () => {
    const root = new FakeRoot();
    applySettings(root, { theme: 'dark', glass: 'auto', osReducedTransparency: false });
    expect(root.snapshot()).toEqual({ 'data-theme': 'dark' });
    applySettings(root, { theme: 'dark', glass: 'solid', osReducedTransparency: false });
    expect(root.snapshot()).toEqual({ 'data-theme': 'dark', 'data-transparency': 'reduced' });
    applySettings(root, { theme: 'system', glass: 'solid', osReducedTransparency: false });
    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
  });
});

describe('OS flag without stored settings', () => {
  it('still sets data-transparency when get_settings fails, and leaves data-theme to the OS', async () => {
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos', reducedTransparency: true }));
    getSettingsMock.mockRejectedValue(INTERNAL);
    const root = new FakeRoot();
    bindSettingsToRoot(root);

    await useSettings.getState().load();

    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
    expect(useSettings.getState().error).toMatchObject({ code: 'internal' });
  });

  it('keeps the OS flag when a later update answers with Glass: Auto and another theme', async () => {
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos', reducedTransparency: true }));
    getSettingsMock.mockResolvedValue({ glass: 'auto', theme: 'system', leftPanelWidth: 248 });
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    await useSettings.getState().load();

    updateSettingsMock.mockResolvedValueOnce({ glass: 'auto', theme: 'light', leftPanelWidth: 248 });
    await useSettings.getState().setTheme('light');

    expect(root.snapshot()).toEqual({ 'data-theme': 'light', 'data-transparency': 'reduced' });
  });
});

describe('loadSettings (startup, never blocks the UI)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves as soon as load finishes and leaves no timer running', async () => {
    vi.useFakeTimers();
    appReadyMock.mockResolvedValue(bootstrap());
    getSettingsMock.mockResolvedValue({ glass: 'solid', theme: 'dark', leftPanelWidth: 248 });

    await loadSettings(1000);

    expect(useSettings.getState()).toMatchObject({
      glass: 'solid',
      theme: 'dark',
      loaded: true,
      error: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after the timeout and keeps the defaults when the backend never answers', async () => {
    vi.useFakeTimers();
    appReadyMock.mockReturnValue(new Promise<AppBootstrap>(() => undefined));
    getSettingsMock.mockReturnValue(new Promise<Settings>(() => undefined));
    const root = new FakeRoot();
    bindSettingsToRoot(root);

    const done = loadSettings(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(useSettings.getState().loaded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(useSettings.getState()).toMatchObject({
      glass: 'auto',
      theme: 'system',
      loaded: true,
    });
    expect(useSettings.getState().error).toMatchObject({
      code: 'internal',
      retryable: true,
    });
    expect(root.snapshot()).toEqual({});
  });

  it('applies an answer that arrives after the timeout', async () => {
    vi.useFakeTimers();
    const answers: Array<(settings: Settings) => void> = [];
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos', reducedTransparency: true }));
    getSettingsMock.mockReturnValue(
      new Promise<Settings>((resolve) => {
        answers.push(resolve);
      }),
    );
    const root = new FakeRoot();
    bindSettingsToRoot(root);

    const done = loadSettings(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(useSettings.getState().error).not.toBeNull();

    answers[0]?.({ glass: 'solid', theme: 'dark', leftPanelWidth: 248 });
    await vi.advanceTimersByTimeAsync(0);

    expect(useSettings.getState()).toMatchObject({
      glass: 'solid',
      theme: 'dark',
      loaded: true,
      error: null,
    });
    expect(root.snapshot()).toEqual({
      'data-theme': 'dark',
      'data-transparency': 'reduced',
    });
  });

  it('reports the backend error, not a timeout, for a load that failed in time', async () => {
    vi.useFakeTimers();
    appReadyMock.mockRejectedValue(INTERNAL);
    getSettingsMock.mockRejectedValue(INTERNAL);
    await expect(loadSettings(1000)).resolves.toBeUndefined();
    expect(useSettings.getState()).toMatchObject({
      loaded: true,
      error: { code: 'internal', retryable: false },
    });
  });

  it('uses a default timeout of a few seconds', () => {
    expect(SETTINGS_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(SETTINGS_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('OS transparency channel', () => {
  type Handler = (reduced: boolean) => void;

  /** A stand-in for `watchTransparency` that keeps the handler, so the test can play the backend. */
  function fakeWatch() {
    let handler: Handler | undefined;
    const watch = vi.fn((next: Handler) => {
      handler = next;
      return Promise.resolve();
    });
    return { watch, send: (reduced: boolean) => handler?.(reduced) };
  }

  it('opens the channel and turns data-transparency on and off with what it carries', async () => {
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    const { watch, send } = fakeWatch();

    await watchOsTransparency(useSettings, watch);

    expect(watch).toHaveBeenCalledTimes(1);
    send(true);
    expect(useSettings.getState().osReducedTransparency).toBe(true);
    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
    send(false);
    expect(useSettings.getState().osReducedTransparency).toBe(false);
    expect(root.snapshot()).toEqual({});
  });

  it('keeps Glass: Solid when the OS flag turns off', async () => {
    useSettings.setState({ glass: 'solid', osReducedTransparency: true });
    const root = new FakeRoot();
    bindSettingsToRoot(root);
    const { watch, send } = fakeWatch();
    await watchOsTransparency(useSettings, watch);

    send(false);

    expect(root.snapshot()).toEqual({ 'data-transparency': 'reduced' });
  });

  it('never rejects: if the backend refuses the channel the flag stays as load read it', async () => {
    useSettings.setState({ osReducedTransparency: true });
    const refused = vi.fn(() => Promise.reject(new Error('watch_transparency not allowed')));
    await expect(watchOsTransparency(useSettings, refused)).resolves.toBeUndefined();
    expect(useSettings.getState().osReducedTransparency).toBe(true);
  });
});

describe('startup wiring (src/main.tsx)', () => {
  const source = readFileSync(fileURLToPath(new URL('../main.tsx', import.meta.url)), 'utf8');

  it('renders at once and loads the settings afterwards, so a silent backend cannot blank the window', () => {
    const bind = source.indexOf('bindSettingsToRoot(document.documentElement)');
    const render = source.indexOf('.render(');
    const load = source.indexOf('loadSettings()');
    expect(bind).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(bind);
    expect(load).toBeGreaterThan(render);
  });

  it('never waits for the backend: the load is started and left to apply its result', () => {
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).toMatch(/^void loadSettings\(\);$/m);
  });

  it('follows live OS transparency changes', () => {
    expect(source).toMatch(/^void watchOsTransparency\(\);$/m);
  });
});
