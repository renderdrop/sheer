import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toAppError } from './errors';
import { checkForUpdate, isUpdaterUnconfigured, parseUpdateEvent, parseUpdateInfo } from './update';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const UNCONFIGURED = {
  code: 'unsupported_feature',
  key: 'error.unsupported_feature',
  retryable: false,
  params: { what: 'updater_unconfigured' },
};

describe('the placeholder-key refusal', () => {
  it('is recognized on a rejected check, and only that one', async () => {
    invokeMock.mockRejectedValueOnce(UNCONFIGURED);
    const error = toAppError(await checkForUpdate().catch((e: unknown) => e));
    expect(isUpdaterUnconfigured(error)).toBe(true);
    expect(isUpdaterUnconfigured(toAppError({ code: 'unsupported_feature', params: { what: 'xfa' } }))).toBe(false);
    expect(isUpdaterUnconfigured(toAppError({ code: 'unsupported_feature' }))).toBe(false);
    expect(isUpdaterUnconfigured(toAppError({ code: 'internal' }))).toBe(false);
  });
});

describe('the wire shapes the backend sends', () => {
  it('parses the info of the Rust `UpdateInfo` and the damaged-file failure of a bad signature', () => {
    expect(parseUpdateInfo({ version: '1.0.1', date: '2026-10-04', notes: 'a\nb' })).toStrictEqual({
      version: '1.0.1',
      date: '2026-10-04',
      notes: 'a\nb',
    });
    expect(parseUpdateEvent({ kind: 'failed', code: 'damaged_file' })).toStrictEqual({
      kind: 'failed',
      code: 'damaged_file',
    });
  });
});
