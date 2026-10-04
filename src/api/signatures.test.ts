import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseAnnotation } from './annotations';
import {
  createDrawnSignature,
  createTypedSignature,
  discardSignatureDraft,
  importSignatureImage,
  parseAssetInfo,
  parseSignatureArt,
  parseSignatureDraft,
} from './signatures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const VECTOR = {
  type: 'vector',
  w: 2000,
  h: 1000,
  paths: [[['M', 1, 2], ['L', 3, 4], ['C', 1, 2, 3, 4, 5, 6], ['Z']]],
};

describe('signature art', () => {
  it('reads vector and raster art', () => {
    expect(parseSignatureArt(VECTOR)).toStrictEqual(VECTOR);
    expect(parseSignatureArt({ type: 'raster', w: 4, h: 3, png: 'x' })).toStrictEqual({ type: 'raster', w: 4, h: 3 });
  });
  it.each([
    ['no size', { type: 'vector', paths: [] }],
    ['a command that is not one', { ...VECTOR, paths: [[['M', 1]]] }],
    [
      'an unknown command',
      {
        ...VECTOR,
        paths: [
          [
            ['M', 1, 2],
            ['Q', 1, 2, 3, 4],
          ],
        ],
      },
    ],
    ['a path without a start', { ...VECTOR, paths: [[['L', 1, 2], ['Z']]] }],
    ['a number that is not finite', { ...VECTOR, paths: [[['M', 1, Number.NaN]]] }],
    [
      'legacy polygons',
      {
        ...VECTOR,
        paths: [
          [
            [1, 2],
            [3, 4],
            [5, 6],
          ],
        ],
      },
    ],
    ['too many paths', { ...VECTOR, paths: Array.from({ length: 65 }, () => [['M', 1, 2]]) }],
    ['an unknown type', { type: 'file', w: 1, h: 1 }],
    ['fractional raster pixels', { type: 'raster', w: 1.5, h: 1 }],
  ])('rejects %s', (_n, value) => expect(parseSignatureArt(value)).toBeNull());

  it('reads drafts and assets', () => {
    expect(parseSignatureDraft({ id: 3, role: 'initials', art: VECTOR })?.id).toBe(3);
    expect(parseSignatureDraft({ id: 3, role: 'other', art: VECTOR })).toBeNull();
    expect(parseAssetInfo({ assetId: 1, aspect: 2, art: VECTOR })?.aspect).toBe(2);
    expect(parseAssetInfo({ assetId: 1, aspect: 0, art: VECTOR })).toBeNull();
  });
});

describe('commands', () => {
  it('creates a typed signature and passes the arguments', async () => {
    invokeMock.mockResolvedValue({ id: 1, role: 'signature', art: VECTOR });
    await createTypedSignature('signature', 'Ada');
    expect(invokeMock).toHaveBeenCalledWith('create_typed_signature', {
      role: 'signature',
      text: 'Ada',
      font: 'homemadeApple',
    });
  });
  it('sends the drawn outlines as path commands', async () => {
    invokeMock.mockResolvedValue({ id: 2, role: 'signature', art: VECTOR });
    const outlines = [[['M', 1, 2], ['C', 1, 2, 3, 4, 5, 6], ['Z']]] as const;
    const draft = await createDrawnSignature('signature', outlines);
    expect(invokeMock).toHaveBeenCalledWith('create_drawn_signature', { role: 'signature', outlines });
    expect(draft.art).toStrictEqual(VECTOR);
  });
  it('discards a draft by id', async () => {
    invokeMock.mockResolvedValue(undefined);
    await discardSignatureDraft(4);
    expect(invokeMock).toHaveBeenCalledWith('discard_signature_draft', { draftId: 4 });
  });
  it('a cancelled import is null and a malformed answer rejects', async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await importSignatureImage('signature', true)).toBeNull();
    invokeMock.mockResolvedValueOnce({ nope: 1 });
    await expect(importSignatureImage('signature', true)).rejects.toBeDefined();
  });
});

describe('signature and mark annotations', () => {
  const common = {
    id: 1,
    pageId: 0,
    rect: { x: 1, y: 2, w: 30, h: 10 },
    color: [0, 0, 0],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
  };
  const box = { x: 1, y: 2, w: 30, h: 10 };
  it('parses both kinds', () => {
    for (const body of [
      { kind: 'signature', box, role: 'signature', art: { type: 'asset', assetId: 2, aspect: 3 } },
      { kind: 'signature', box, role: 'initials', art: { type: 'file' } },
      { kind: 'mark', box, glyph: 'dot' },
    ]) {
      const wire = { ...common, ...body };
      expect(parseAnnotation(wire)).toStrictEqual(wire);
    }
  });
  it('rejects bad art, role and glyph', () => {
    expect(parseAnnotation({ ...common, kind: 'signature', box, role: 'x', art: { type: 'file' } })).toBeNull();
    expect(
      parseAnnotation({
        ...common,
        kind: 'signature',
        box,
        role: 'signature',
        art: { type: 'asset', assetId: 1, aspect: 0 },
      }),
    ).toBeNull();
    expect(parseAnnotation({ ...common, kind: 'mark', box, glyph: 'star' })).toBeNull();
  });
});
