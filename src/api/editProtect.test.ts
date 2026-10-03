import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseChangeSet, parseContentAnnotation, parseAnnotations, type DocCommand } from './annotations';
import { getAssetPreview, insertImageDialog, parseImageAssetInfo } from './content';
import { parseDocFlags } from './documents';
import { toAppError } from './errors';
import { parseJobEvent } from './jobs';
import { getMetadata, parseDocMetadata, removeMetadata, setMetadata } from './metadata';
import { cropPages, parseSlot } from './pages';
import { getProtection, parseProtectionInfo, stageProtection, stageUnprotection } from './protection';
import { markRedactions } from './redaction';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  // The job channel is only constructed here, never fed.
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const P = { x: 1, y: 2 };
const QUAD = [P, P, P, P];
const HISTORY = { canUndo: true, canRedo: false, undoLabel: 'x', redoLabel: null, dirty: true };
const COMMON = {
  id: 7,
  pageId: 0,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  color: [0, 0, 0],
  opacity: 1,
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  locked: false,
  sync: 'new',
};
const TEXT_BOX = {
  ...COMMON,
  kind: 'textBox',
  box: { x: 0, y: 0, w: 80, h: 20 },
  text: 'a\nb',
  lines: ['a', 'b'],
  font: 'sans',
  fontSize: 12,
  align: 'left',
};
const IMAGE = { ...COMMON, kind: 'image', box: { x: 0, y: 0, w: 80, h: 20 }, assetId: 3, aspect: 4 };
const MARK = { ...COMMON, kind: 'redactMark', quads: [QUAD], source: 'area' };
const NOTE = { ...COMMON, kind: 'note', at: P, icon: 'note' };

describe('content objects and redaction marks', () => {
  it('are read as content, apart from the comments', () => {
    expect(parseContentAnnotation(TEXT_BOX)).toStrictEqual(TEXT_BOX);
    expect(parseContentAnnotation(IMAGE)?.kind).toBe('image');
    expect(parseContentAnnotation(MARK)?.kind).toBe('redactMark');
    expect(parseContentAnnotation(NOTE)).toBeNull();
    // A page list with both reads as the comments only; nothing is an error.
    expect(parseAnnotations([NOTE, TEXT_BOX, MARK])?.map((a) => a.kind)).toEqual(['note']);
  });

  it.each([
    ['an unknown font', { ...TEXT_BOX, font: 'comic' }],
    ['an unknown alignment', { ...TEXT_BOX, align: 'justify' }],
    ['text that is not text', { ...TEXT_BOX, text: 1 }],
    ['an image without an asset', { ...IMAGE, assetId: -1 }],
    ['an image with no aspect', { ...IMAGE, aspect: 0 }],
    ['a mark without quads', { ...MARK, quads: [] }],
    ['a mark from nowhere', { ...MARK, source: 'ocr' }],
  ])('rejects %s', (_name, wire) => {
    expect(parseContentAnnotation(wire)).toBeNull();
  });

  it('puts them into ChangeSet.content and keeps doc when the backend sends it', () => {
    const wire = {
      rev: 2,
      upserted: [NOTE, TEXT_BOX, MARK],
      removed: [],
      pages: null,
      fields: [],
      doc: ['metadata'],
      history: HISTORY,
    };
    const changes = parseChangeSet(wire);
    expect(changes?.upserted.map((a) => a.kind)).toEqual(['note']);
    expect(changes?.content?.map((a) => a.kind)).toEqual(['textBox', 'redactMark']);
    expect(changes?.doc).toEqual(['metadata']);
    expect(parseChangeSet({ ...wire, doc: ['everything'] })).toBeNull();
    expect(parseChangeSet({ ...wire, upserted: [{ ...TEXT_BOX, font: 'x' }] })).toBeNull();
    // Without them the shape is the old one.
    expect(parseChangeSet({ ...wire, upserted: [NOTE], doc: undefined })).not.toHaveProperty('content');
    expect(parseChangeSet({ ...wire, upserted: [NOTE], doc: undefined })).not.toHaveProperty('doc');
  });
});

describe('pages with a crop', () => {
  const slot = { id: 1, width: 600, height: 800, rotation: 0, rev: 0, label: null, origin: 'redacted' };

  it('reads the media box and the crop, and builds the command', () => {
    const media = { width: 612, height: 792 };
    const crop = { top: 1, right: 2, bottom: 3, left: 4 };
    expect(parseSlot({ ...slot, media, crop })).toMatchObject({ origin: 'redacted', media, crop });
    expect(parseSlot({ ...slot, media, crop: null })?.crop).toBeNull();
    // Without them (a fixture) the slot is as before.
    expect(parseSlot(slot)).not.toHaveProperty('media');
    expect(parseSlot({ ...slot, media: { width: 0, height: 1 } })).toBeNull();
    expect(parseSlot({ ...slot, crop: { top: -1, right: 0, bottom: 0, left: 0 } })).toBeNull();
    const command: DocCommand = cropPages([1, 2], { type: 'margins', ...crop });
    expect(command).toEqual({ type: 'cropPages', pages: [1, 2], spec: { type: 'margins', ...crop } });
    expect(cropPages([1], { type: 'reset' }).spec).toEqual({ type: 'reset' });
  });
});

describe('errors, flags and jobs of edit and protect', () => {
  it('keeps one non-ASCII character of a text box error and nothing else', () => {
    expect(toAppError({ code: 'invalid_argument', params: { what: 'textBox', char: '中' } }).params).toEqual({
      what: 'textBox',
      char: '中',
    });
    for (const char of ['a', '/', '<', 'ab中', '', 7]) {
      expect(toAppError({ code: 'invalid_argument', params: { what: 'textBox', char } }).params).toEqual({
        what: 'textBox',
      });
    }
  });

  it('reads the permissions of a document when they are there', () => {
    const base = { encrypted: true, xfa: false, hasForms: false, signed: false };
    expect(parseDocFlags(base)).toStrictEqual(base);
    expect(parseDocFlags({ ...base, permissions: null })).toStrictEqual({ ...base, permissions: null });
    expect(parseDocFlags({ ...base, permissions: ['print'] })?.permissions).toEqual(['print']);
    expect(parseDocFlags({ ...base, permissions: ['all'] })).toBeNull();
    expect(parseDocFlags({ ...base, permissions: 'print' })).toBeNull();
  });

  it('reads the redact phase, its warning and the changes of a finished job', () => {
    expect(parseJobEvent({ type: 'progress', phase: 'redact', done: 1, total: 2 })).toMatchObject({ phase: 'redact' });
    const done = {
      type: 'done',
      outputs: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      warnings: ['unsavedEditsDropped'],
      opened: null,
    };
    expect(parseJobEvent(done)).toMatchObject({ warnings: ['unsavedEditsDropped'] });
    expect(parseJobEvent(done)).not.toHaveProperty('changes');
    expect(parseJobEvent({ ...done, changes: null })).toMatchObject({ changes: null });
    const changes = { rev: 3, upserted: [], removed: [], pages: null, fields: [], history: HISTORY };
    expect(parseJobEvent({ ...done, changes })).toMatchObject({ changes: { rev: 3 } });
    expect(parseJobEvent({ ...done, changes: { rev: 'x' } })).toBeNull();
  });
});

describe('the wrappers', () => {
  const changes = { rev: 1, upserted: [], removed: [], pages: null, fields: [], doc: ['protection'], history: HISTORY };

  it('inserts an image and asks for its frame', async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await insertImageDialog(4)).toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith('insert_image_dialog', { docId: 4 });
    invokeMock.mockResolvedValueOnce({ assetId: 2, width: 40, height: 20, aspect: 2, path: 'x' });
    expect(await insertImageDialog(4)).toStrictEqual({ assetId: 2, width: 40, height: 20, aspect: 2 });
    invokeMock.mockResolvedValueOnce({ assetId: 2 });
    await expect(insertImageDialog(4)).rejects.toMatchObject({ code: 'internal' });
    expect(parseImageAssetInfo({ assetId: 1, width: 0, height: 1, aspect: 1 })).toBeNull();
    invokeMock.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);
    await expect(getAssetPreview(4, 2, 256)).rejects.toMatchObject({ code: 'internal' });
    expect(invokeMock).toHaveBeenLastCalledWith('get_asset_preview', { docId: 4, assetId: 2, maxPx: 256 });
  });

  it('sends the redaction, metadata and protection commands as the backend names them', async () => {
    invokeMock.mockResolvedValue(changes);
    await markRedactions(1, [{ pageId: 0, quads: [[P, P, P, P]], source: 'text' }]);
    expect(invokeMock).toHaveBeenLastCalledWith('apply_command', {
      docId: 1,
      command: { type: 'markRedactions', marks: [{ pageId: 0, quads: [[P, P, P, P]], source: 'text' }] },
    });
    await setMetadata(1, { title: null, author: 'A' });
    expect(invokeMock).toHaveBeenLastCalledWith('apply_command', {
      docId: 1,
      command: { type: 'setMetadata', patch: { title: null, author: 'A' } },
    });
    await removeMetadata(1);
    expect(invokeMock).toHaveBeenLastCalledWith('apply_command', { docId: 1, command: { type: 'removeMetadata' } });
    const opts = { openPassword: 'a', permissionsPassword: null, allow: ['print' as const] };
    expect((await stageProtection(1, opts)).doc).toEqual(['protection']);
    expect(invokeMock).toHaveBeenLastCalledWith('stage_protection', { docId: 1, opts });
    await stageUnprotection(1);
    expect(invokeMock).toHaveBeenLastCalledWith('stage_unprotection', { docId: 1, permissionsPassword: null });
    await stageUnprotection(1, 'owner');
    expect(invokeMock).toHaveBeenLastCalledWith('stage_unprotection', { docId: 1, permissionsPassword: 'owner' });
    invokeMock.mockResolvedValueOnce({ nope: true });
    await expect(stageProtection(1, opts)).rejects.toMatchObject({ code: 'internal' });
  });

  it('reads protection info and metadata, and treats another shape as internal', async () => {
    const info = { encrypted: true, method: 'aes256', ownerRights: false, allow: ['copy'], pending: 'none' };
    invokeMock.mockResolvedValueOnce({ ...info, extra: 1 });
    expect(await getProtection(2)).toStrictEqual(info);
    expect(invokeMock).toHaveBeenLastCalledWith('get_protection', { docId: 2 });
    expect(parseProtectionInfo({ ...info, method: 'des' })).toBeNull();
    expect(parseProtectionInfo({ ...info, allow: ['copy', 'copy', 'copy', 'copy'] })).toBeNull();

    const metadata = {
      title: 'T',
      author: null,
      subject: null,
      keywords: null,
      creator: null,
      producer: 'P',
      created: '2026-01-02T03:04:05Z',
      modified: null,
      pdfVersion: '1.7',
      fileBytes: 1234,
      xmp: { present: true, bytes: 99 },
      truncated: false,
      pending: 'edited',
    };
    invokeMock.mockResolvedValueOnce(metadata);
    expect(await getMetadata(2)).toStrictEqual(metadata);
    expect(parseDocMetadata({ ...metadata, title: 'x'.repeat(2001) })).toBeNull();
    expect(parseDocMetadata({ ...metadata, xmp: { present: 'yes', bytes: 1 } })).toBeNull();
    expect(parseDocMetadata({ ...metadata, pending: 'maybe' })).toBeNull();
    invokeMock.mockResolvedValueOnce(null);
    await expect(getMetadata(2)).rejects.toMatchObject({ code: 'internal' });
  });
});
