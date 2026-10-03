import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import { PANEL } from '../components/tokens';
import {
  GLASS_MODES,
  LANGUAGES,
  LEFT_PANEL_WIDTH,
  THEME_MODES,
  appReady,
  getSettings,
  parseAppEvent,
  parseBootstrap,
  parseMenuMessage,
  parseSettings,
  parseTransparencyMessage,
  subscribeApp,
  subscribeMenu,
  updateSettings,
  watchTransparency,
} from './app';

/** A `Channel` that keeps its handler, so a test can play the backend by calling `onmessage`. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe('parseSettings', () => {
  it('accepts every combination of known values', () => {
    for (const glass of GLASS_MODES) {
      for (const theme of THEME_MODES) {
        for (const language of LANGUAGES) {
          const settings = {
            glass,
            theme,
            language,
            leftPanelWidth: 248,
            welcomeTour: 'pending',
            authorName: 'Author',
            authorPrompt: 'pending',
          };
          expect(parseSettings(settings)).toEqual(settings);
        }
      }
    }
  });

  it('accepts the whole range of the left panel width and nothing outside it', () => {
    for (const leftPanelWidth of [LEFT_PANEL_WIDTH.min, 193, 320, LEFT_PANEL_WIDTH.max]) {
      expect(
        parseSettings({
          glass: 'auto',
          theme: 'system',
          language: 'system',
          leftPanelWidth,
          welcomeTour: 'shown',
          authorName: 'Author',
          authorPrompt: 'pending',
        }),
      ).toMatchObject({
        leftPanelWidth,
      });
    }
    for (const bad of [
      191,
      401,
      0,
      -248,
      248.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '248',
      null,
      undefined,
      true,
      [248],
    ]) {
      expect(
        parseSettings({
          glass: 'auto',
          theme: 'system',
          language: 'system',
          leftPanelWidth: bad,
          welcomeTour: 'pending',
          authorName: 'Author',
          authorPrompt: 'pending',
        }),
        String(bad),
      ).toBeNull();
    }
  });

  it('mirrors the left panel range of the splitter (PANEL) and of the backend (limits.rs)', () => {
    expect(LEFT_PANEL_WIDTH).toEqual({ min: PANEL.min, max: PANEL.max, default: PANEL.default });
  });

  it('rejects anything else', () => {
    for (const bad of [
      null,
      undefined,
      'dark',
      7,
      [],
      {},
      { glass: 'auto' },
      { theme: 'system' },
      { glass: 'Auto', theme: 'system' },
      {
        glass: 'auto',
        theme: 'dim',
        language: 'system',
        leftPanelWidth: 248,
        welcomeTour: 'pending',
        authorName: 'Author',
        authorPrompt: 'pending',
      },
      {
        glass: 1,
        theme: 'system',
        language: 'system',
        leftPanelWidth: 248,
        welcomeTour: 'pending',
        authorName: 'Author',
        authorPrompt: 'pending',
      },
      {
        glass: 'auto',
        theme: 'system',
        language: 'system',
        leftPanelWidth: 248,
        welcomeTour: 'done',
        authorName: 'Author',
        authorPrompt: 'pending',
      },
      { glass: 'auto', theme: 'system', language: 'system', leftPanelWidth: 248 },
      // A language that is not one of the three wire names: a tag, another case, another language.
      ...['de-DE', 'DE', 'fr', '', null, 1].map((language) => ({
        glass: 'auto',
        theme: 'system',
        language,
        leftPanelWidth: 248,
      })),
      // Without the width or the language, or with an older shape of the settings.
      { glass: 'auto', theme: 'system', leftPanelWidth: 248 },
      { glass: 'auto', theme: 'system', language: 'system' },
      { glass: 'auto', theme: 'system' },
    ]) {
      expect(parseSettings(bad)).toBeNull();
    }
  });

  it('drops unknown keys', () => {
    expect(
      parseSettings({
        glass: 'solid',
        theme: 'light',
        language: 'de',
        leftPanelWidth: 300,
        welcomeTour: 'shown',
        authorName: 'Author',
        authorPrompt: 'pending',
        extra: '<img src=x>',
      }),
    ).toEqual({
      glass: 'solid',
      theme: 'light',
      language: 'de',
      leftPanelWidth: 300,
      welcomeTour: 'shown',
      authorName: 'Author',
      authorPrompt: 'pending',
    });
  });
});

describe('parseBootstrap', () => {
  it('accepts the backend shape', () => {
    expect(parseBootstrap({ platform: 'macos', reducedTransparency: true, version: '0.2.0' })).toEqual({
      platform: 'macos',
      reducedTransparency: true,
      version: '0.2.0',
      authorSuggestion: '',
    });
    expect(
      parseBootstrap({ platform: 'macos', reducedTransparency: true, version: '0.2.0', authorSuggestion: 'user' }),
    ).toMatchObject({ authorSuggestion: 'user' });
  });

  it('rejects other platforms, types and shapes', () => {
    for (const bad of [
      null,
      {},
      { platform: 'macos', reducedTransparency: true },
      { platform: 'beos', reducedTransparency: false, version: '1' },
      { platform: 'windows', reducedTransparency: 'yes', version: '1' },
      { platform: 'windows', reducedTransparency: false, version: 1 },
    ]) {
      expect(parseBootstrap(bad)).toBeNull();
    }
  });
});

describe('commands', () => {
  it('app_ready and get_settings take no arguments', async () => {
    invokeMock.mockResolvedValueOnce({ platform: 'windows', reducedTransparency: false, version: '0.2.0' });
    await expect(appReady()).resolves.toMatchObject({ platform: 'windows' });
    expect(invokeMock).toHaveBeenLastCalledWith('app_ready', undefined);

    invokeMock.mockResolvedValueOnce({
      glass: 'auto',
      theme: 'system',
      language: 'system',
      leftPanelWidth: 248,
      welcomeTour: 'pending',
      authorName: 'Author',
      authorPrompt: 'pending',
    });
    await expect(getSettings()).resolves.toEqual({
      glass: 'auto',
      theme: 'system',
      language: 'system',
      leftPanelWidth: 248,
      welcomeTour: 'pending',
      authorName: 'Author',
      authorPrompt: 'pending',
    });
    expect(invokeMock).toHaveBeenLastCalledWith('get_settings', undefined);
  });

  it('update_settings sends only the patch and returns the settings after the update', async () => {
    invokeMock.mockResolvedValueOnce({
      glass: 'solid',
      theme: 'system',
      language: 'system',
      leftPanelWidth: 248,
      welcomeTour: 'pending',
      authorName: 'Author',
      authorPrompt: 'pending',
    });
    await expect(updateSettings({ glass: 'solid' })).resolves.toEqual({
      glass: 'solid',
      theme: 'system',
      language: 'system',
      leftPanelWidth: 248,
      welcomeTour: 'pending',
      authorName: 'Author',
      authorPrompt: 'pending',
    });
    expect(invokeMock).toHaveBeenCalledWith('update_settings', { patch: { glass: 'solid' } });
  });

  it('turns a malformed answer into the generic error', async () => {
    invokeMock.mockResolvedValueOnce({ glass: 'frosted', theme: 'system' });
    await expect(getSettings()).rejects.toEqual({ code: 'internal', key: 'error.internal', retryable: false });
    invokeMock.mockResolvedValueOnce(null);
    await expect(appReady()).rejects.toMatchObject({ code: 'internal' });
  });

  it('rejects with an AppError, such as the backend refusing a value', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'settings' },
    });
    await expect(updateSettings({ theme: 'dark' })).rejects.toMatchObject({
      code: 'invalid_argument',
      params: { what: 'settings' },
    });
  });
});

describe('watchTransparency', () => {
  /** The channel the command was given: what the backend would send on. */
  const channelOf = (): { onmessage: (message: unknown) => void } => {
    const args = invokeMock.mock.calls.at(-1)?.[1] as { onChange: { onmessage: (message: unknown) => void } };
    return args.onChange;
  };

  it('hands the backend a channel and passes on every flag it sends', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onChange = vi.fn();
    await watchTransparency(onChange);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('watch_transparency');
    expect(Object.keys(invokeMock.mock.calls[0]?.[1] ?? {})).toEqual(['onChange']);

    channelOf().onmessage(true);
    channelOf().onmessage(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('ignores anything that is not a boolean', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onChange = vi.fn();
    await watchTransparency(onChange);
    for (const bad of [null, undefined, 'true', 0, 1, {}, { reduced: true }, [true]]) channelOf().onmessage(bad);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects with an AppError when the backend refuses', async () => {
    invokeMock.mockRejectedValueOnce(new Error('command watch_transparency not allowed'));
    await expect(watchTransparency(vi.fn())).rejects.toMatchObject({ code: 'internal' });
  });

  it('reads a message as the bare flag', () => {
    expect(parseTransparencyMessage(true)).toBe(true);
    expect(parseTransparencyMessage(false)).toBe(false);
    for (const bad of [null, undefined, 'false', 0, {}, { reduced: true }]) {
      expect(parseTransparencyMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('subscribeMenu', () => {
  /** The channel the command was given: what the backend would send on. */
  const channelOf = (): { onmessage: (message: unknown) => void } => {
    const args = invokeMock.mock.calls.at(-1)?.[1] as { onAction: { onmessage: (message: unknown) => void } };
    return args.onAction;
  };

  it('hands the backend a channel and the OS language, and passes on every id it sends', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onAction = vi.fn();
    await subscribeMenu(onAction, 'de-AT');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('subscribe_menu');
    expect(Object.keys(invokeMock.mock.calls[0]?.[1] ?? {}).sort()).toEqual(['onAction', 'systemLanguage']);
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ systemLanguage: 'de-AT' });

    channelOf().onmessage('open');
    channelOf().onmessage('toggle-left-panel');
    expect(onAction.mock.calls).toEqual([['open'], ['toggle-left-panel']]);
  });

  it('ignores anything that is not an id: the message is data from outside', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onAction = vi.fn();
    await subscribeMenu(onAction, 'en');
    for (const bad of [
      null,
      undefined,
      1,
      true,
      {},
      ['open'],
      { id: 'open' },
      '',
      'Open',
      'open now',
      '<script>',
      'a'.repeat(65),
    ]) {
      channelOf().onmessage(bad);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it('hands the backend a new channel on every call, so a second subscription can replace the first there', async () => {
    invokeMock.mockResolvedValue(undefined);
    const first = vi.fn();
    const second = vi.fn();
    await subscribeMenu(first, 'en');
    const firstChannel = channelOf();
    await subscribeMenu(second, 'de');
    const secondChannel = channelOf();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(['subscribe_menu', 'subscribe_menu']);
    expect(secondChannel).not.toBe(firstChannel);
    // Each channel feeds only its own handler; what the backend sends after the replacement arrives on the second.
    secondChannel.onmessage('zoom-in');
    expect(second.mock.calls).toEqual([['zoom-in']]);
    expect(first).not.toHaveBeenCalled();
  });

  it('rejects with an AppError when the backend refuses', async () => {
    invokeMock.mockRejectedValueOnce(new Error('command subscribe_menu not allowed'));
    await expect(subscribeMenu(vi.fn(), 'en')).rejects.toMatchObject({ code: 'internal' });
  });

  it('reads a message as the bare id of a menu item', () => {
    for (const good of ['open', 'close-document', 'zoom-in', 'toggle-left-panel', 'a1', 'a'.repeat(64)]) {
      expect(parseMenuMessage(good), good).toBe(good);
    }
    for (const bad of [null, undefined, 7, '', '-', 'open-', '-open', 'Open', 'zoom_in', 'zoom in', 'a'.repeat(65)]) {
      expect(parseMenuMessage(bad), String(bad)).toBeNull();
    }
  });
});

describe('subscribeApp', () => {
  /** The channel the command was given: what the backend would send on. */
  const channelOf = (): { onmessage: (message: unknown) => void } => {
    const args = invokeMock.mock.calls.at(-1)?.[1] as { onEvent: { onmessage: (message: unknown) => void } };
    return args.onEvent;
  };

  const REPORT = { id: 3, pageCount: 12, displayName: 'Report.pdf' };

  it('hands the backend one channel and nothing else, and passes on every event it sends', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onEvent = vi.fn();
    await subscribeApp(onEvent);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('subscribe_app');
    expect(Object.keys(invokeMock.mock.calls[0]?.[1] ?? {})).toEqual(['onEvent']);

    channelOf().onmessage({ type: 'dropHover', active: true });
    channelOf().onmessage({ type: 'opened', document: REPORT });
    channelOf().onmessage({ type: 'dropHover', active: false });
    channelOf().onmessage({ type: 'openFailed', code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false });
    expect(onEvent.mock.calls).toEqual([
      [{ type: 'dropHover', active: true }],
      [{ type: 'opened', document: REPORT }],
      [{ type: 'dropHover', active: false }],
      [{ type: 'openFailed', error: { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false } }],
    ]);
  });

  it('ignores anything that is not an event: the message is data from outside', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onEvent = vi.fn();
    await subscribeApp(onEvent);
    for (const bad of [
      null,
      undefined,
      1,
      'opened',
      true,
      [],
      {},
      { type: 'dropHover' },
      { type: 'dropHover', active: 'yes' },
      { type: 'opened' },
      { type: 'opened', document: { id: -1, pageCount: 1, displayName: 'a.pdf' } },
      { type: 'navigate', url: 'https://example.com' },
      { active: true },
    ]) {
      channelOf().onmessage(bad);
    }
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('never lets a path through: an event holds only the fields it is documented to have', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onEvent = vi.fn();
    await subscribeApp(onEvent);
    channelOf().onmessage({
      type: 'opened',
      document: { ...REPORT, path: 'C:\\Users\\user\\Report.pdf' },
      paths: ['x'],
    });
    channelOf().onmessage({ type: 'dropHover', active: true, paths: ['C:\\Users\\user\\Report.pdf'] });
    expect(onEvent.mock.calls).toStrictEqual([
      [{ type: 'opened', document: REPORT }],
      [{ type: 'dropHover', active: true }],
    ]);
  });

  it('keeps a failed open to its code, key, retryable and whitelisted params: a path or a message in it is dropped', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onEvent = vi.fn();
    await subscribeApp(onEvent);
    channelOf().onmessage({
      type: 'openFailed',
      code: 'io_not_found',
      key: 'error.io_not_found',
      retryable: false,
      path: 'C:\\Users\\user\\Report.pdf',
      message: 'The system cannot find the file specified. (os error 2)',
    });
    channelOf().onmessage({
      type: 'openFailed',
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'C:\\Users\\user', limit: 32 },
    });
    expect(onEvent.mock.calls).toStrictEqual([
      [{ type: 'openFailed', error: { code: 'io_not_found', key: 'error.io_not_found', retryable: false } }],
      [{ type: 'openFailed', error: { code: 'limit_exceeded', key: 'error.limit_exceeded', retryable: false } }],
    ]);
  });

  it('hands the backend a new channel on every call, so a second subscription can replace the first there', async () => {
    invokeMock.mockResolvedValue(undefined);
    const first = vi.fn();
    const second = vi.fn();
    await subscribeApp(first);
    const firstChannel = channelOf();
    await subscribeApp(second);
    const secondChannel = channelOf();
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(['subscribe_app', 'subscribe_app']);
    expect(secondChannel).not.toBe(firstChannel);
    secondChannel.onmessage({ type: 'dropHover', active: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('rejects with an AppError when the backend refuses', async () => {
    invokeMock.mockRejectedValueOnce(new Error('command subscribe_app not allowed'));
    await expect(subscribeApp(vi.fn())).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('parseAppEvent', () => {
  it('reads the three events and nothing else', () => {
    expect(parseAppEvent({ type: 'dropHover', active: false })).toEqual({ type: 'dropHover', active: false });
    expect(parseAppEvent({ type: 'opened', document: { id: 0, pageCount: 1, displayName: '' } })).toEqual({
      type: 'opened',
      document: { id: 0, pageCount: 1, displayName: '' },
    });
    expect(
      parseAppEvent({
        type: 'openFailed',
        code: 'limit_exceeded',
        key: 'error.limit_exceeded',
        retryable: false,
        params: { what: 'documents', limit: 32 },
      }),
    ).toEqual({
      type: 'openFailed',
      error: {
        code: 'limit_exceeded',
        key: 'error.limit_exceeded',
        retryable: false,
        params: { what: 'documents', limit: 32 },
      },
    });
    expect(parseAppEvent(null)).toBeNull();
    expect(parseAppEvent({ type: 'other' })).toBeNull();
  });
});

describe('the window has no event permission (SECURITY T3)', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const sources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it('no source imports the event API: backend pushes come through a Channel passed to a command', () => {
    const files = sources(src);
    expect(files.some((file) => file.endsWith('call.ts'))).toBe(true);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/@tauri-apps\/api\/event/);
      expect(text, file).not.toMatch(/\bonDragDropEvent\b/);
    }
  });
});
