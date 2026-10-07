import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ANNOTATIONS_PER_DOC,
  MAX_ANNOTATIONS_PER_PAGE,
  MAX_ANNOT_CONTENTS_CHARS,
  MAX_ANNOT_QUADS,
  MAX_FREE_TEXT_LINES,
  MAX_HISTORY_ENTRIES,
  importWarnings,
  MAX_INK_POINTS_PER_STROKE,
  MAX_INK_STROKES,
  applyCommand,
  listAnnotations,
  listDocumentAnnotations,
  parseAnnotation,
  parseChangeSet,
  redo,
  undo,
  type DocCommand,
} from './annotations';
import { rustConstants } from './limits.testutil';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const RECT = { x: 10, y: 20, w: 50, h: 12 };
const POINT = { x: 1, y: 2 };
const QUAD = [POINT, POINT, POINT, POINT];

/** The fields every annotation has, as the backend sends them. */
const common = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: 1,
  pageId: 0,
  rect: RECT,
  color: [255, 235, 0],
  opacity: 1,
  contents: '',
  author: null,
  modified: '2024-01-02T03:04:05Z',
  inReplyTo: null,
  locked: false,
  sync: 'new',
  ...extra,
});

const BODIES: Record<string, Record<string, unknown>> = {
  highlight: { kind: 'highlight', quads: [QUAD] },
  underline: { kind: 'underline', quads: [QUAD] },
  strikeout: { kind: 'strikeout', quads: [QUAD] },
  note: { kind: 'note', at: POINT, icon: 'comment' },
  freeText: {
    kind: 'freeText',
    box: RECT,
    lines: ['a', 'b'],
    fontSize: 12,
    fill: [255, 248, 77],
    borderWidth: 1,
    align: 'center',
    borderColor: [31, 158, 106],
  },
  ink: { kind: 'ink', strokes: [{ points: [POINT], outline: [POINT, POINT, POINT] }], width: 2 },
  rect: { kind: 'rect', box: RECT, width: 1, fill: [1, 2, 3], dashed: true },
  ellipse: { kind: 'ellipse', box: RECT, width: 1, fill: null, dashed: false },
  line: { kind: 'line', from: POINT, to: { x: 5, y: 6 }, width: 1, head: 'none', tail: 'closedArrow' },
  opaque: { kind: 'opaque', subtype: 'Stamp' },
};
const NOTE = BODIES.note ?? {};

const HISTORY = { canUndo: true, canRedo: false, undoLabel: 'annotation.create', redoLabel: null, dirty: true };

describe('parseAnnotation', () => {
  it.each(Object.keys(BODIES))('reads a %s with its geometry', (kind) => {
    const wire = common(BODIES[kind] ?? {});
    expect(parseAnnotation(wire)).toStrictEqual(wire);
  });

  it('reads a free text from before alignment and border colour existed as left and without a border colour', () => {
    const old = common({ kind: 'freeText', box: RECT, lines: ['a'], fontSize: 12, fill: null, borderWidth: 0 });
    expect(parseAnnotation(old)).toMatchObject({ align: 'left', borderColor: null });
    expect(parseAnnotation(common({ ...BODIES.freeText, align: 'justify' }))).toBeNull();
    expect(parseAnnotation(common({ ...BODIES.freeText, borderColor: [1, 2] }))).toBeNull();
  });

  it('drops keys that are not part of an annotation', () => {
    const parsed = parseAnnotation(common({ ...NOTE, path: 'C:\\x.pdf', rect: { ...RECT, z: 1 } }));
    expect(parsed).toStrictEqual(common(NOTE));
  });

  it('reads the optional fields: author, reply link, lock, other sync states', () => {
    const wire = common({ ...NOTE, author: 'Ada', inReplyTo: 4, locked: true, sync: 'modified', modified: 'D:2024' });
    expect(parseAnnotation(wire)).toStrictEqual(wire);
    expect(parseAnnotation(common({ ...NOTE, sync: 'clean' }))?.sync).toBe('clean');
  });

  it.each([
    ['a value that is not an object', 7],
    ['an unknown kind', common({ kind: 'squiggly', quads: [QUAD] })],
    ['no kind', common({})],
    ['a negative id', common({ ...NOTE, id: -1 })],
    ['a fractional page', common({ ...NOTE, pageId: 0.5 })],
    ['an opacity above 1', common({ ...NOTE, opacity: 1.2 })],
    ['a colour channel above 255', common({ ...NOTE, color: [256, 0, 0] })],
    ['a colour with two channels', common({ ...NOTE, color: [1, 2] })],
    ['a rect with a negative size', common({ ...NOTE, rect: { ...RECT, w: -1 } })],
    ['a coordinate beyond the page range', common({ ...NOTE, at: { x: 20_000, y: 0 } })],
    ['a note with an unknown icon', common({ ...NOTE, icon: 'star' })],
    ['a sync state that does not exist', common({ ...NOTE, sync: 'dirty' })],
    ['an author that is a number', common({ ...NOTE, author: 3 })],
    ['contents that are not text', common({ ...NOTE, contents: null })],
    ['a highlight without quads', common({ kind: 'highlight', quads: [] })],
    ['a quad with three corners', common({ kind: 'highlight', quads: [[POINT, POINT, POINT]] })],
    ['an ink annotation without strokes', common({ kind: 'ink', strokes: [], width: 1 })],
    ['a line with an unknown end', common({ ...BODIES.line, head: 'diamond' })],
    ['a free text line that is a number', common({ ...BODIES.freeText, lines: [1] })],
    ['a rect with a fill of two channels', common({ ...BODIES.rect, fill: [1, 2] })],
    ['a rect whose dashed flag is a string', common({ ...BODIES.rect, dashed: 'yes' })],
  ])('rejects %s', (_name, wire) => {
    expect(parseAnnotation(wire)).toBeNull();
  });

  it('bounds the sizes it reads', () => {
    const quads = (count: number) => Array.from({ length: count }, () => QUAD);
    expect(parseAnnotation(common({ kind: 'highlight', quads: quads(MAX_ANNOT_QUADS + 1) }))).toBeNull();
    expect(parseAnnotation(common({ kind: 'highlight', quads: quads(MAX_ANNOT_QUADS) }))).not.toBeNull();
    const stroke = { points: [POINT], outline: [] };
    const strokes = Array.from({ length: MAX_INK_STROKES + 1 }, () => stroke);
    expect(parseAnnotation(common({ kind: 'ink', width: 1, strokes }))).toBeNull();
    const long = { points: Array.from({ length: MAX_INK_POINTS_PER_STROKE + 1 }, () => POINT), outline: [] };
    expect(parseAnnotation(common({ kind: 'ink', width: 1, strokes: [long] }))).toBeNull();
    const lines = Array.from({ length: MAX_FREE_TEXT_LINES + 1 }, () => 'x');
    expect(parseAnnotation(common({ ...BODIES.freeText, lines }))).toBeNull();
    expect(parseAnnotation(common({ ...NOTE, contents: 'x'.repeat(2 * MAX_ANNOT_CONTENTS_CHARS + 1) }))).toBeNull();
  });
});

describe('parseChangeSet', () => {
  const wire = (extra: Record<string, unknown> = {}) => ({
    rev: 3,
    upserted: [common(NOTE)],
    removed: [4, 5],
    pages: null,
    fields: [],
    history: HISTORY,
    ...extra,
  });

  it('reads the revision, the delta and the history', () => {
    expect(parseChangeSet(wire())).toStrictEqual(wire());
    const slot = { id: 3, width: 612, height: 792, rotation: 90, rev: 1, label: null, origin: 'file' };
    expect(parseChangeSet(wire({ pages: [slot] }))?.pages).toEqual([slot]);
  });

  it.each([
    ['a revision that is negative', wire({ rev: -1 })],
    ['an upserted list with a bad annotation', wire({ upserted: [{}] })],
    ['removed ids that are not ids', wire({ removed: ['a'] })],
    ['a history without a flag', wire({ history: { ...HISTORY, dirty: undefined } })],
    ['a history label that is a number', wire({ history: { ...HISTORY, undoLabel: 1 } })],
    ['no history', wire({ history: undefined })],
    ['pages that are not ids', wire({ pages: ['x'] })],
    ['fields that are not field states', wire({ fields: [{ id: 1 }] })],
    ['nothing', null],
  ])('rejects %s', (_name, value) => {
    expect(parseChangeSet(value)).toBeNull();
  });

  it('bounds the delta to the size of a document', () => {
    const removed = Array.from({ length: MAX_ANNOTATIONS_PER_DOC + 1 }, (_, id) => id);
    expect(parseChangeSet(wire({ removed }))).toBeNull();
  });
});

describe('the commands', () => {
  it('list_annotations asks for a page and returns its annotations', async () => {
    const answer = [common(BODIES.highlight ?? {}), common({ ...NOTE, id: 2 })];
    invokeMock.mockResolvedValueOnce(answer);
    await expect(listAnnotations(4, 1)).resolves.toStrictEqual(answer);
    expect(invokeMock).toHaveBeenCalledWith('list_annotations', { docId: 4, pageId: 1 });
  });

  it('list_annotations rejects with an internal error for an answer of the wrong shape', async () => {
    invokeMock.mockResolvedValueOnce([{ id: 1 }]);
    await expect(listAnnotations(0, 0)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce(Array.from({ length: MAX_ANNOTATIONS_PER_PAGE + 1 }, () => common(NOTE)));
    await expect(listAnnotations(0, 0)).rejects.toMatchObject({ code: 'internal' });
  });

  it('apply_command sends the command as it is and returns the change set', async () => {
    const command: DocCommand = {
      type: 'batch',
      label: 'annotation.paste',
      commands: [
        { type: 'createAnnotation', draft: { pageId: 0, color: [1, 2, 3], kind: 'note', at: POINT, icon: 'note' } },
        { type: 'updateAnnotation', id: 3, patch: { fill: null, contents: 'x' }, coalesce: 'text' },
        { type: 'moveAnnotations', ids: [1, 2], dx: 5, dy: -5 },
        { type: 'deleteAnnotations', ids: [9] },
      ],
    };
    const changes = { rev: 1, upserted: [], removed: [], pages: null, fields: [], history: HISTORY };
    invokeMock.mockResolvedValueOnce(changes);
    await expect(applyCommand(2, command)).resolves.toStrictEqual(changes);
    expect(invokeMock).toHaveBeenCalledWith('apply_command', { docId: 2, command });
  });

  it('undo and redo take the document and return the change set', async () => {
    const changes = {
      rev: 2,
      upserted: [],
      removed: [1],
      pages: null,
      fields: [],
      history: { ...HISTORY, canRedo: true },
    };
    invokeMock.mockResolvedValue(changes);
    await expect(undo(7)).resolves.toStrictEqual(changes);
    expect(invokeMock).toHaveBeenLastCalledWith('undo', { docId: 7 });
    await expect(redo(7)).resolves.toStrictEqual(changes);
    expect(invokeMock).toHaveBeenLastCalledWith('redo', { docId: 7 });
  });

  it('rejects with the backend error, whole', async () => {
    invokeMock.mockRejectedValue({
      code: 'not_found',
      key: 'error.not_found',
      retryable: false,
      params: { what: 'annotation' },
    });
    await expect(applyCommand(0, { type: 'deleteAnnotations', ids: [1] })).rejects.toMatchObject({
      code: 'not_found',
      params: { what: 'annotation' },
    });
    await expect(undo(0)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the bounds mirror the backend (src-tauri/src/limits.rs)', () => {
  it('has the same value for every limit the parsers check', () => {
    const rust = rustConstants();
    expect(rust.get('MAX_ANNOTATIONS_PER_DOC')).toBe(MAX_ANNOTATIONS_PER_DOC);
    expect(rust.get('MAX_ANNOTATIONS_PER_PAGE')).toBe(MAX_ANNOTATIONS_PER_PAGE);
    expect(rust.get('MAX_ANNOT_QUADS')).toBe(MAX_ANNOT_QUADS);
    expect(rust.get('MAX_INK_STROKES')).toBe(MAX_INK_STROKES);
    expect(rust.get('MAX_INK_POINTS_PER_STROKE')).toBe(MAX_INK_POINTS_PER_STROKE);
    expect(rust.get('MAX_FREE_TEXT_LINES')).toBe(MAX_FREE_TEXT_LINES);
    expect(rust.get('MAX_ANNOT_CONTENTS_CHARS')).toBe(MAX_ANNOT_CONTENTS_CHARS);
    expect(rust.get('MAX_HISTORY_ENTRIES')).toBe(MAX_HISTORY_ENTRIES);
  });
});

describe('import_warnings', () => {
  it('asks for the document and keeps well-formed warnings only', async () => {
    invokeMock.mockResolvedValueOnce([
      { type: 'pageTruncated', page: 3, skipped: 2 },
      { type: 'x' },
      { type: 'pageTruncated', page: -1, skipped: 1 },
    ]);
    await expect(importWarnings(4)).resolves.toStrictEqual([{ type: 'pageTruncated', page: 3, skipped: 2 }]);
    expect(invokeMock).toHaveBeenCalledWith('import_warnings', { docId: 4 });
  });

  it('answers an empty list for a wrong shape', async () => {
    invokeMock.mockResolvedValueOnce('x');
    await expect(importWarnings(4)).resolves.toStrictEqual([]);
  });
});

describe('list_document_annotations', () => {
  const summary = {
    id: 1,
    pageId: 0,
    kind: 'note',
    color: [1, 2, 3],
    contents: 'hi',
    author: null,
    modified: null,
    inReplyTo: null,
  };

  it('asks for the document and returns the summaries', async () => {
    invokeMock.mockResolvedValueOnce([summary]);
    await expect(listDocumentAnnotations(4)).resolves.toStrictEqual([summary]);
    expect(invokeMock).toHaveBeenCalledWith('list_document_annotations', { docId: 4 });
  });

  it('accepts the Fill & Sign marks and signatures among the comments (F11)', async () => {
    const kinds = ['highlight', 'note', 'freeText', 'ink', 'rect', 'ellipse', 'line', 'mark', 'signature', 'opaque'];
    invokeMock.mockResolvedValueOnce(kinds.map((kind, id) => ({ ...summary, id, kind })));
    const listed = await listDocumentAnnotations(4);
    expect(listed.map((s) => s.kind)).toStrictEqual(kinds);
  });

  it('rejects an answer of the wrong shape', async () => {
    for (const bad of [[{ ...summary, kind: 'nope' }], [{ ...summary, color: [1, 2] }], [{ id: 1 }], 'x']) {
      invokeMock.mockResolvedValueOnce(bad);
      await expect(listDocumentAnnotations(0)).rejects.toMatchObject({ code: 'internal' });
    }
  });
});

describe('stamps (ADR-139)', () => {
  const STAMP = { kind: 'stamp', box: RECT, stamp: 'received', text: 'RECEIVED', date: '07.10.2026', tone: 'solar' };

  it('reads a stamp with its text, date and tone and a missing date as null', () => {
    const wire = common(STAMP);
    expect(parseAnnotation(wire)).toStrictEqual(wire);
    const undated: Record<string, unknown> = { ...STAMP };
    delete undated.date;
    expect(parseAnnotation(common(undated))).toMatchObject({ date: null });
  });

  it.each([
    ['an unknown stamp kind', { ...STAMP, stamp: 'urgent' }],
    ['an unknown tone', { ...STAMP, tone: 'rose' }],
    ['a text that is not a string', { ...STAMP, text: 4 }],
    ['an absurdly long text', { ...STAMP, text: 'x'.repeat(500) }],
    ['a box that is not a rect', { ...STAMP, box: 3 }],
  ])('rejects %s', (_name, body) => {
    expect(parseAnnotation(common(body))).toBeNull();
  });

  it('sends a stamp draft and a stamp patch as they are', async () => {
    invokeMock.mockResolvedValue({ rev: 1, upserted: [], removed: [], history: HISTORY });
    const create: DocCommand = {
      type: 'createAnnotation',
      draft: {
        pageId: 0,
        color: [255, 248, 77],
        kind: 'stamp',
        box: { x: 5, y: 5, w: 0, h: 0 },
        stamp: 'custom',
        text: 'Gepr\u00fcft',
        tone: 'ink',
      },
    };
    await applyCommand(1, create);
    const update: DocCommand = {
      type: 'updateAnnotation',
      id: 3,
      patch: { stampText: 'OK', stampDate: null, stampTone: 'solar' },
      coalesce: 'stamp:3',
    };
    await applyCommand(1, update);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'apply_command', expect.objectContaining({ command: create }));
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'apply_command', expect.objectContaining({ command: update }));
  });
});
