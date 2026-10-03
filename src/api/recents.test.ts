import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseOpenOutcome, unlockDocument } from './documents';
import {
  listRecents,
  locateRecent,
  openRecent,
  parseRecentEntry,
  removeRecent,
  restoreRecent,
  setMenuState,
} from './recents';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => invoke.mockReset());

const entry = { id: 3, displayName: 'a.pdf', folder: 'Docs', lastOpened: 1700000000, missing: false };

describe('the needsPassword outcome', () => {
  it('is an id and a name, nothing else', () => {
    expect(parseOpenOutcome({ type: 'needsPassword', id: 2, displayName: 'x.pdf', path: 'C:/secret' })).toEqual({
      type: 'needsPassword',
      id: 2,
      displayName: 'x.pdf',
    });
    expect(parseOpenOutcome({ type: 'needsPassword', id: -1, displayName: 'x' })).toBeNull();
    expect(parseOpenOutcome({ type: 'needsPassword', id: 1 })).toBeNull();
  });
});

describe('unlockDocument', () => {
  it('sends the id and the password and returns the document', async () => {
    invoke.mockResolvedValue({ id: 2, pageCount: 4, displayName: 'x.pdf' });
    await expect(unlockDocument(2, 'pw')).resolves.toEqual({ id: 2, pageCount: 4, displayName: 'x.pdf' });
    expect(invoke).toHaveBeenCalledWith('unlock_document', { docId: 2, password: 'pw' });
  });

  it('turns a wrong password into the app error and a malformed answer into an internal one', async () => {
    invoke.mockRejectedValueOnce({ code: 'password_required', key: 'error.password_required', retryable: false });
    await expect(unlockDocument(2, 'x')).rejects.toMatchObject({ code: 'password_required' });
    invoke.mockResolvedValueOnce({ nope: true });
    await expect(unlockDocument(2, 'x')).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('recent files', () => {
  it('parses an entry and refuses anything else', () => {
    expect(parseRecentEntry({ ...entry, path: 'C:/x' })).toEqual(entry);
    expect(parseRecentEntry({ ...entry, missing: 'no' })).toBeNull();
    expect(parseRecentEntry({ ...entry, id: -1 })).toBeNull();
    expect(parseRecentEntry({ ...entry, folder: 3 })).toBeNull();
    expect(parseRecentEntry(null)).toBeNull();
  });

  it('lists, removes and opens by id', async () => {
    invoke.mockResolvedValueOnce([entry]);
    await expect(listRecents()).resolves.toEqual([entry]);
    expect(invoke).toHaveBeenLastCalledWith('list_recents', undefined);
    invoke.mockResolvedValueOnce(undefined);
    await removeRecent(3);
    expect(invoke).toHaveBeenLastCalledWith('remove_recent', { recentId: 3 });
    invoke.mockResolvedValueOnce({ type: 'needsPassword', id: 9, displayName: 'a.pdf' });
    await expect(openRecent(3)).resolves.toMatchObject({ type: 'needsPassword', id: 9 });
    expect(invoke).toHaveBeenLastCalledWith('open_recent', { recentId: 3 });
  });

  it('restores a removed entry and lets the user locate a moved file, by id only', async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(restoreRecent(4)).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('restore_recent', { recentId: 4 });
    invoke.mockResolvedValueOnce(false);
    await expect(locateRecent(4)).resolves.toBe(false);
    expect(invoke).toHaveBeenLastCalledWith('locate_recent', { recentId: 4 });
    invoke.mockResolvedValueOnce('yes');
    await expect(locateRecent(4)).resolves.toBe(false);
  });

  it('refuses a list that is too long or malformed', async () => {
    invoke.mockResolvedValueOnce(Array.from({ length: 51 }, () => entry));
    await expect(listRecents()).rejects.toMatchObject({ code: 'internal' });
    invoke.mockResolvedValueOnce([{ id: 1 }]);
    await expect(listRecents()).rejects.toMatchObject({ code: 'internal' });
  });

  it('tells the menu bar whether a document is open', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await setMenuState(true);
    expect(invoke).toHaveBeenCalledWith('set_menu_state', { hasDocument: true });
  });
});
