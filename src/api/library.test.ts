import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSignatureLibrary,
  deleteSignature,
  getLibrarySignature,
  type LibraryArt,
  listSignatures,
  parseLibraryArt,
  parseLibraryItem,
  parseSignatureLibrary,
  renameSignature,
  saveLibrarySignature,
} from './library';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => invoke.mockReset());

const id = 'a'.repeat(32);
const vector: LibraryArt = {
  vector: {
    w: 3000,
    h: 1000,
    paths: [[['M', 0, 0], ['L', 10, 0], ['C', 10, 5, 5, 10, 0, 10], ['Z']]],
  },
};
const item = { id, role: 'signature', name: 'Work', created: 1700000000, aspect: 3, kind: 'vector', preview: vector };

describe('library art', () => {
  it('accepts vector and raster art and drops extra keys', () => {
    expect(parseLibraryArt(vector)).toEqual(vector);
    const raster = { raster: { w: 30, h: 10, png: 'iVBORw0KGgo=', extra: 1 } };
    expect(parseLibraryArt(raster)).toEqual({ raster: { w: 30, h: 10, png: 'iVBORw0KGgo=' } });
  });

  it('refuses anything else', () => {
    expect(parseLibraryArt(null)).toBeNull();
    expect(parseLibraryArt({})).toBeNull();
    expect(parseLibraryArt({ vector: { w: 0, h: 10, paths: [] } })).toBeNull();
    expect(parseLibraryArt({ vector: { w: 1, h: 1, paths: [[['M', 0, Number.NaN]]] } })).toBeNull();
    expect(parseLibraryArt({ vector: { w: 1, h: 1, paths: [[['M', 0, 1, 2]]] } })).toBeNull();
    expect(parseLibraryArt({ raster: { w: 1, h: 1, png: 'not base64!' } })).toBeNull();
    expect(parseLibraryArt({ vector: vector.vector, raster: { w: 1, h: 1, png: 'AA==' } })).toBeNull();
  });
});

describe('library entries', () => {
  it('parses an entry with or without a preview', () => {
    expect(parseLibraryItem({ ...item, secret: 'x' })).toEqual(item);
    expect(parseLibraryItem({ ...item, kind: 'raster', preview: null })).toEqual({
      ...item,
      kind: 'raster',
      preview: null,
    });
  });

  it('refuses a malformed entry', () => {
    expect(parseLibraryItem({ ...item, id: 'A'.repeat(32) })).toBeNull();
    expect(parseLibraryItem({ ...item, id: '../x' })).toBeNull();
    expect(parseLibraryItem({ ...item, role: 'stamp' })).toBeNull();
    expect(parseLibraryItem({ ...item, aspect: 0 })).toBeNull();
    expect(parseLibraryItem({ ...item, created: -1 })).toBeNull();
    expect(parseLibraryItem({ ...item, kind: 'svg' })).toBeNull();
    expect(parseLibraryItem({ ...item, preview: { vector: 1 } })).toBeNull();
    expect(parseLibraryItem(undefined)).toBeNull();
  });

  it('parses the list and refuses a bad status or more than 8 per role', () => {
    expect(parseSignatureLibrary({ status: 'ready', items: [item] })).toEqual({ status: 'ready', items: [item] });
    expect(parseSignatureLibrary({ status: 'locked', items: [] })).toEqual({ status: 'locked', items: [] });
    expect(parseSignatureLibrary({ status: 'broken', items: [] })).toBeNull();
    expect(parseSignatureLibrary({ status: 'ready', items: [{}] })).toBeNull();
    const nine = Array.from({ length: 9 }, () => item);
    expect(parseSignatureLibrary({ status: 'ready', items: nine })).toBeNull();
    const mixed = [
      ...Array.from({ length: 8 }, () => item),
      ...Array.from({ length: 8 }, () => ({ ...item, role: 'initials' })),
    ];
    expect(parseSignatureLibrary({ status: 'ready', items: mixed })?.items).toHaveLength(16);
  });
});

describe('library commands', () => {
  it('lists and turns a malformed answer into an internal error', async () => {
    invoke.mockResolvedValueOnce({ status: 'unavailable', items: [item] });
    await expect(listSignatures()).resolves.toEqual({ status: 'unavailable', items: [item] });
    expect(invoke).toHaveBeenLastCalledWith('list_signatures', undefined);
    invoke.mockResolvedValueOnce({ nope: true });
    await expect(listSignatures()).rejects.toMatchObject({ code: 'internal' });
  });

  it('saves, renames, deletes, gets and clears with the names the backend expects', async () => {
    invoke.mockResolvedValueOnce(item);
    await expect(saveLibrarySignature('signature', 'Work', vector)).resolves.toEqual(item);
    expect(invoke).toHaveBeenLastCalledWith('save_library_signature', { role: 'signature', name: 'Work', art: vector });

    invoke.mockResolvedValueOnce(undefined);
    await renameSignature(id, 'Home');
    expect(invoke).toHaveBeenLastCalledWith('rename_signature', { itemId: id, name: 'Home' });

    invoke.mockResolvedValueOnce(undefined);
    await deleteSignature(id);
    expect(invoke).toHaveBeenLastCalledWith('delete_signature', { itemId: id });

    invoke.mockResolvedValueOnce({ id, role: 'initials', art: vector, extra: 1 });
    await expect(getLibrarySignature(id)).resolves.toEqual({ id, role: 'initials', art: vector });
    expect(invoke).toHaveBeenLastCalledWith('get_library_signature', { itemId: id });

    invoke.mockResolvedValueOnce(undefined);
    await clearSignatureLibrary();
    expect(invoke).toHaveBeenLastCalledWith('clear_signature_library', undefined);
  });

  it('maps backend errors to app errors', async () => {
    invoke.mockRejectedValueOnce({ code: 'limit_exceeded', key: 'error.limit_exceeded', retryable: false });
    await expect(saveLibrarySignature('initials', 'x', vector)).rejects.toMatchObject({ code: 'limit_exceeded' });
    invoke.mockResolvedValueOnce({ id: 'bad', role: 'initials', art: vector });
    await expect(getLibrarySignature(id)).rejects.toMatchObject({ code: 'internal' });
  });
});
