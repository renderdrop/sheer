import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openDefaultAppsSettings, parseSettings } from './app';
import { parseDocumentInfo } from './documents';
import {
  AUTOSAVE_STATUSES,
  discardAllRecoveries,
  discardRecovery,
  listRecoveries,
  parseRecoveryEntry,
  restoreRecovery,
} from './recovery';
import {
  checkForUpdate,
  downloadUpdate,
  installUpdateOnQuit,
  parseUpdateEvent,
  parseUpdateInfo,
  skipUpdateVersion,
} from './update';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const NOT_YET = {
  code: 'unsupported_feature',
  key: 'error.unsupported_feature',
  retryable: false,
  params: { what: 'notYet' },
};
const INTERNAL = { code: 'internal', key: 'error.internal', retryable: false };
const ENTRY = {
  id: 3,
  displayName: 'a.pdf',
  folder: 'Taxes',
  savedAt: '2026-10-04T10:00:00Z',
  pageCount: 2,
  original: 'changed',
};

describe('recovery commands', () => {
  it('lists records and drops what is not part of them', async () => {
    invokeMock.mockResolvedValueOnce([ENTRY, { ...ENTRY, id: 4, folder: null, path: 'C:\\secret.pdf' }]);
    const entries = await listRecoveries();
    expect(invokeMock).toHaveBeenCalledWith('list_recoveries', undefined);
    expect(entries).toStrictEqual([ENTRY, { ...ENTRY, id: 4, folder: null }]);
  });

  it('treats a malformed record as an internal error', async () => {
    for (const bad of [{ ...ENTRY, original: 'gone' }, { ...ENTRY, id: -1 }, { ...ENTRY, savedAt: 'yesterday' }, 'x']) {
      invokeMock.mockResolvedValueOnce([bad]);
      await expect(listRecoveries()).rejects.toMatchObject({ code: 'internal' });
    }
    invokeMock.mockResolvedValueOnce({ not: 'a list' });
    await expect(listRecoveries()).rejects.toMatchObject({ code: 'internal' });
    expect(parseRecoveryEntry({ ...ENTRY, folder: 5 })).toBeNull();
  });

  it('restores through the open path and discards by id', async () => {
    invokeMock.mockResolvedValueOnce({
      type: 'opened',
      document: { id: 9, pageCount: 2, displayName: 'a.pdf', kind: 'recovered' },
    });
    await expect(restoreRecovery(3)).resolves.toMatchObject({ type: 'opened', document: { kind: 'recovered' } });
    expect(invokeMock).toHaveBeenLastCalledWith('restore_recovery', { id: 3 });
    invokeMock.mockResolvedValueOnce({ nope: true });
    await expect(restoreRecovery(3)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce(undefined);
    await discardRecovery(3);
    expect(invokeMock).toHaveBeenLastCalledWith('discard_recovery', { id: 3 });
    invokeMock.mockResolvedValueOnce(2);
    await expect(discardAllRecoveries()).resolves.toBe(2);
    invokeMock.mockResolvedValueOnce(-1);
    await expect(discardAllRecoveries()).rejects.toMatchObject({ code: 'internal' });
  });

  it('shows the stub answer as an AppError until package B2', async () => {
    invokeMock.mockRejectedValueOnce(NOT_YET);
    await expect(listRecoveries()).rejects.toMatchObject({ code: 'unsupported_feature' });
  });

  it('knows the autosave statuses and the recovered kind', () => {
    expect([...AUTOSAVE_STATUSES]).toStrictEqual(['on', 'offEncrypted', 'offTooLarge', 'clean']);
    expect(parseDocumentInfo({ id: 1, pageCount: 1, displayName: 'x', kind: 'recovered' })).toMatchObject({
      kind: 'recovered',
    });
  });
});

describe('update commands', () => {
  it('checks, with null for up to date', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(checkForUpdate()).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce({ version: '1.0.1', date: null, notes: 'Fixes', extra: 1 });
    await expect(checkForUpdate()).resolves.toStrictEqual({ version: '1.0.1', date: null, notes: 'Fixes' });
    invokeMock.mockResolvedValueOnce({ version: '', date: null, notes: '' });
    await expect(checkForUpdate()).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockRejectedValueOnce(INTERNAL);
    await expect(checkForUpdate()).rejects.toMatchObject({ code: 'internal' });
  });

  it('bounds the info', () => {
    expect(parseUpdateInfo({ version: 'x'.repeat(33), date: null, notes: '' })).toBeNull();
    expect(parseUpdateInfo({ version: '1.0.0', date: null, notes: 'n'.repeat(4097) })).toBeNull();
    expect(parseUpdateInfo({ version: '1.0.0', date: '2026-10-04', notes: 'n'.repeat(4096) })).not.toBeNull();
    expect(parseUpdateInfo({ version: '1.0.0', date: 5, notes: '' })).toBeNull();
  });

  it('parses the download events and ignores unknown messages', async () => {
    expect(parseUpdateEvent({ kind: 'progress', downloaded: 5, total: null })).toStrictEqual({
      kind: 'progress',
      downloaded: 5,
      total: null,
    });
    expect(parseUpdateEvent({ kind: 'progress', downloaded: -1, total: null })).toBeNull();
    expect(parseUpdateEvent({ kind: 'verified' })).toStrictEqual({ kind: 'verified' });
    expect(parseUpdateEvent({ kind: 'failed', code: 'damaged_file' })).toStrictEqual({
      kind: 'failed',
      code: 'damaged_file',
    });
    expect(parseUpdateEvent({ kind: 'failed', code: 'made_up' })).toBeNull();
    expect(parseUpdateEvent({ kind: 'other' })).toBeNull();

    const seen: unknown[] = [];
    invokeMock.mockResolvedValueOnce(undefined);
    await downloadUpdate((event) => seen.push(event));
    const channel = (invokeMock.mock.calls.at(-1)?.[1] as { onEvent: { onmessage: (m: unknown) => void } }).onEvent;
    channel.onmessage({ kind: 'verified' });
    channel.onmessage({ kind: 'bogus' });
    expect(seen).toStrictEqual([{ kind: 'verified' }]);
  });

  it('passes the quit mark, the skipped version and the settings link through', async () => {
    invokeMock.mockResolvedValue(undefined);
    await installUpdateOnQuit();
    expect(invokeMock).toHaveBeenLastCalledWith('install_update_on_quit', undefined);
    await skipUpdateVersion('1.0.1');
    expect(invokeMock).toHaveBeenLastCalledWith('skip_update_version', { version: '1.0.1' });
    await openDefaultAppsSettings();
    expect(invokeMock).toHaveBeenLastCalledWith('open_default_apps_settings', undefined);
  });
});

describe('the updater settings', () => {
  const BASE = {
    glass: 'auto',
    theme: 'system',
    language: 'system',
    leftPanelWidth: 248,
    welcomeTour: 'pending',
    authorName: '',
    authorPrompt: 'pending',
  };

  it('are optional until the backend sends them, and checked when it does', () => {
    expect(parseSettings(BASE)).not.toHaveProperty('updates');
    expect(parseSettings({ ...BASE, updates: 'off', skippedVersion: null })).toMatchObject({
      updates: 'off',
      skippedVersion: null,
    });
    expect(parseSettings({ ...BASE, updates: 'on', skippedVersion: '2.0.0' })).toMatchObject({
      updates: 'on',
      skippedVersion: '2.0.0',
    });
    const odd = parseSettings({ ...BASE, updates: 'maybe', skippedVersion: 'x'.repeat(33) });
    expect(odd).not.toHaveProperty('updates');
    expect(odd).not.toHaveProperty('skippedVersion');
  });
});
