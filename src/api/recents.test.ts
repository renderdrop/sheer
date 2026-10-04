import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseOpenOutcome, unlockDocument } from './documents';
import {
  getRecentThumbnail,
  listRecents,
  locateRecent,
  openRecent,
  parseRecentEntry,
  removeRecent,
  restoreRecent,
  revealRecent,
  setMenuState,
  setRecentStarred,
} from './recents';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => invoke.mockReset());

const entry = { id: 3, displayName: 'a.pdf', folder: 'Docs', lastOpened: 1700000000, missing: false, starred: false };

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
    expect(parseRecentEntry({ ...entry, starred: true })).toEqual({ ...entry, starred: true });
    expect(parseRecentEntry({ ...entry, starred: undefined })).toBeNull();
  });

  it('stars and reveals by id only', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await setRecentStarred(3, true);
    expect(invoke).toHaveBeenLastCalledWith('set_recent_starred', { recentId: 3, starred: true });
    invoke.mockResolvedValueOnce(undefined);
    await revealRecent(3);
    expect(invoke).toHaveBeenLastCalledWith('reveal_recent', { recentId: 3 });
    invoke.mockRejectedValueOnce({ code: 'not_found', key: 'error.not_found', retryable: false });
    await expect(revealRecent(3)).rejects.toMatchObject({ code: 'not_found' });
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

describe('getRecentThumbnail', () => {
  /** An SHR1 frame (PNG signature and IHDR only: the header is checked against it) of the given size. */
  function frame(width: number, height: number): ArrayBuffer {
    const bytes = new Uint8Array(16 + 8 + 25);
    bytes.set([0x53, 0x48, 0x52, 0x31, 1]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, width, true);
    view.setUint32(12, height, true);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16);
    view.setUint32(24, 13);
    bytes.set([0x49, 0x48, 0x44, 0x52], 28);
    view.setUint32(32, width);
    view.setUint32(36, height);
    return bytes.buffer;
  }

  it('asks by id only and returns the parsed frame', async () => {
    invoke.mockResolvedValue(frame(60, 80));
    const answer = await getRecentThumbnail(4);
    expect(invoke).toHaveBeenCalledWith('get_recent_thumbnail', { recentId: 4 });
    expect([answer.width, answer.height]).toEqual([60, 80]);
  });

  it('rejects an answer that is not a frame and passes a not_found on', async () => {
    invoke.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    await expect(getRecentThumbnail(4)).rejects.toMatchObject({ code: 'internal' });
    invoke.mockRejectedValueOnce({ code: 'not_found', key: 'error.not_found', retryable: false });
    await expect(getRecentThumbnail(4)).rejects.toMatchObject({ code: 'not_found' });
  });
});
