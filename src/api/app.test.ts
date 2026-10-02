import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import { GLASS_MODES, THEME_MODES, appReady, getSettings, parseBootstrap, parseSettings, updateSettings } from './app';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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
