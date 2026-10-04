import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appReady, getSettings, updateSettings, type AppBootstrap, type Settings } from '../api/app';
import { SETTINGS_LOAD_TIMEOUT_MS, loadSettings, useSettings } from './settings';

vi.mock('../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/app')>()),
  appReady: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const appReadyMock = vi.mocked(appReady);
const getSettingsMock = vi.mocked(getSettings);
const updateSettingsMock = vi.mocked(updateSettings);

const bootstrap = (overrides: Partial<AppBootstrap> = {}): AppBootstrap => ({
  platform: 'windows',
  version: '0.2.0',
  authorSuggestion: '',
  paper: 'a4',
  ...overrides,
});

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  language: 'system',
  leftPanelWidth: 248,
  welcomeTour: 'pending',
  authorName: 'Author',
  authorPrompt: 'pending',
  ...overrides,
});

const INTERNAL = { code: 'internal', key: 'error.internal', retryable: false };

beforeEach(() => {
  vi.resetAllMocks();
  useSettings.setState(useSettings.getInitialState(), true);
});

describe('the store has no appearance settings', () => {
  it('holds neither a theme, a glass mode nor an OS transparency flag', () => {
    const state = useSettings.getState() as unknown as Record<string, unknown>;
    for (const key of ['theme', 'glass', 'setTheme', 'setGlass']) {
      expect(key in state, key).toBe(false);
    }
  });
});

describe('load', () => {
  it('mirrors the stored settings and the bootstrap report', async () => {
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos', version: '1.2.3' }));
    getSettingsMock.mockResolvedValue(settings({ language: 'de' }));

    await useSettings.getState().load();

    expect(useSettings.getState()).toMatchObject({
      language: 'de',
      platform: 'macos',
      version: '1.2.3',
      loaded: true,
      error: null,
    });
  });

  it('keeps the defaults and records the error when the backend does not answer', async () => {
    appReadyMock.mockRejectedValue(INTERNAL);
    getSettingsMock.mockRejectedValue(INTERNAL);

    await expect(useSettings.getState().load()).resolves.toBeUndefined();

    expect(useSettings.getState()).toMatchObject({ loaded: true, language: 'system' });
    expect(useSettings.getState().error).toMatchObject({ code: 'internal' });
  });

  it('uses what did arrive when only one of the two calls fails', async () => {
    appReadyMock.mockRejectedValue(INTERNAL);
    getSettingsMock.mockResolvedValue(settings({ language: 'en' }));
    await useSettings.getState().load();
    expect(useSettings.getState()).toMatchObject({ language: 'en', platform: null, loaded: true });
    expect(useSettings.getState().error).not.toBeNull();
  });
});

describe('update', () => {
  it('leaves state alone when the backend rejects the change', async () => {
    useSettings.setState({ language: 'de' });
    updateSettingsMock.mockRejectedValueOnce({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'settings' },
    });

    await expect(useSettings.getState().setLanguage('en')).resolves.toBeUndefined();

    expect(useSettings.getState().language).toBe('de');
    expect(useSettings.getState().error).toMatchObject({ code: 'invalid_argument', params: { what: 'settings' } });
  });

  it('clears the error after the next success', async () => {
    useSettings.setState({ error: { code: 'internal', key: 'error.internal', retryable: false } });
    updateSettingsMock.mockResolvedValueOnce(settings());
    await useSettings.getState().setLanguage('en');
    expect(useSettings.getState().error).toBeNull();
  });

  it('applies what the backend answers, not what was asked', async () => {
    updateSettingsMock.mockResolvedValueOnce(settings({ language: 'system' }));
    await useSettings.getState().setLanguage('de');
    expect(updateSettingsMock).toHaveBeenCalledWith({ language: 'de' });
    expect(useSettings.getState()).toMatchObject({ language: 'system', leftPanelWidth: 248 });
  });

  it('ignores a slow answer that arrives after a newer one', async () => {
    const resolvers: Array<(value: Settings) => void> = [];
    updateSettingsMock.mockImplementation(
      () =>
        new Promise<Settings>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = useSettings.getState().setLanguage('de');
    const second = useSettings.getState().setLanguage('en');
    resolvers[1]?.(settings({ language: 'en' }));
    await second;
    resolvers[0]?.(settings({ language: 'de' }));
    await first;

    expect(useSettings.getState().language).toBe('en');
  });

  it('ignores a slow refusal that arrives after a newer success: no error is shown for a change that was replaced', async () => {
    let refuseFirst: (reason: unknown) => void = () => undefined;
    updateSettingsMock.mockImplementationOnce(
      () =>
        new Promise<Settings>((_resolve, reject) => {
          refuseFirst = reject;
        }),
    );
    updateSettingsMock.mockResolvedValueOnce(settings({ language: 'en' }));

    const first = useSettings.getState().setLanguage('de');
    await useSettings.getState().setLanguage('en');
    refuseFirst(INTERNAL);
    await first;

    expect(useSettings.getState().language).toBe('en');
    expect(useSettings.getState().error).toBeNull();
  });

  it('ignores a slow answer that arrives after a newer refusal: the error stays and the old change is not applied', async () => {
    let answerFirst: (value: Settings) => void = () => undefined;
    updateSettingsMock.mockImplementationOnce(
      () =>
        new Promise<Settings>((resolve) => {
          answerFirst = resolve;
        }),
    );
    updateSettingsMock.mockRejectedValueOnce(INTERNAL);

    const first = useSettings.getState().setLanguage('de');
    await useSettings.getState().setLanguage('en');
    answerFirst(settings({ language: 'de' }));
    await first;

    expect(useSettings.getState().language).toBe('system');
    expect(useSettings.getState().error).toMatchObject({ code: 'internal' });
  });

  it('keeps going after a refusal: the next change goes through and nothing stays pending', async () => {
    updateSettingsMock.mockRejectedValueOnce(INTERNAL);
    updateSettingsMock.mockResolvedValueOnce(settings({ language: 'de' }));

    await useSettings.getState().setLanguage('de');
    expect(useSettings.getState().language).toBe('system');
    await useSettings.getState().setLanguage('de');

    expect(updateSettingsMock).toHaveBeenNthCalledWith(1, { language: 'de' });
    expect(updateSettingsMock).toHaveBeenNthCalledWith(2, { language: 'de' });
    expect(useSettings.getState()).toMatchObject({ language: 'de', error: null });
  });
});

describe('loadSettings (startup, never blocks the UI)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves as soon as load finishes and leaves no timer running', async () => {
    vi.useFakeTimers();
    appReadyMock.mockResolvedValue(bootstrap());
    getSettingsMock.mockResolvedValue(settings({ language: 'de' }));

    await loadSettings(1000);

    expect(useSettings.getState()).toMatchObject({ language: 'de', loaded: true, error: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after the timeout and keeps the defaults when the backend never answers', async () => {
    vi.useFakeTimers();
    appReadyMock.mockReturnValue(new Promise<AppBootstrap>(() => undefined));
    getSettingsMock.mockReturnValue(new Promise<Settings>(() => undefined));

    const done = loadSettings(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(useSettings.getState().loaded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(useSettings.getState()).toMatchObject({ loaded: true, language: 'system' });
    expect(useSettings.getState().error).toMatchObject({ code: 'internal', retryable: true });
  });

  it('applies an answer that arrives after the timeout', async () => {
    vi.useFakeTimers();
    const answers: Array<(value: Settings) => void> = [];
    appReadyMock.mockResolvedValue(bootstrap({ platform: 'macos' }));
    getSettingsMock.mockReturnValue(
      new Promise<Settings>((resolve) => {
        answers.push(resolve);
      }),
    );

    const done = loadSettings(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(useSettings.getState().error).not.toBeNull();

    answers[0]?.(settings({ language: 'de' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(useSettings.getState()).toMatchObject({ language: 'de', loaded: true, error: null });
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

describe('startup wiring (src/main.tsx)', () => {
  const source = readFileSync(fileURLToPath(new URL('../main.tsx', import.meta.url)), 'utf8');

  it('renders at once and loads the settings afterwards, so a silent backend cannot blank the window', () => {
    const render = source.indexOf('.render(');
    const load = source.indexOf('loadSettings()');
    expect(render).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(render);
  });

  it('never waits for the backend: the load is started and left to apply its result', () => {
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).toMatch(/^void loadSettings\(\);$/m);
  });

  it('has no theme or transparency plumbing', () => {
    expect(source).not.toMatch(/Transparency|bindSettingsToRoot/);
  });
});
