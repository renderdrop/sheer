import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import {
  GLASS_MODES,
  THEME_MODES,
  appReady,
  getSettings,
  parseBootstrap,
  parseSettings,
  parseTransparencyMessage,
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
        expect(parseSettings({ glass, theme })).toEqual({ glass, theme });
      }
    }
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
      { glass: 'auto', theme: 'dim' },
      { glass: 1, theme: 'system' },
    ]) {
      expect(parseSettings(bad)).toBeNull();
    }
  });

  it('drops unknown keys', () => {
    expect(parseSettings({ glass: 'solid', theme: 'light', extra: '<img src=x>' })).toEqual({
      glass: 'solid',
      theme: 'light',
    });
  });
});

describe('parseBootstrap', () => {
  it('accepts the backend shape', () => {
    expect(parseBootstrap({ platform: 'macos', reducedTransparency: true, version: '0.2.0' })).toEqual({
      platform: 'macos',
      reducedTransparency: true,
      version: '0.2.0',
    });
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

    invokeMock.mockResolvedValueOnce({ glass: 'auto', theme: 'system' });
    await expect(getSettings()).resolves.toEqual({ glass: 'auto', theme: 'system' });
    expect(invokeMock).toHaveBeenLastCalledWith('get_settings', undefined);
  });

  it('update_settings sends only the patch and returns the settings after the update', async () => {
    invokeMock.mockResolvedValueOnce({ glass: 'solid', theme: 'system' });
    await expect(updateSettings({ glass: 'solid' })).resolves.toEqual({ glass: 'solid', theme: 'system' });
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
