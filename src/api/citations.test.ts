import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseAnnotation, parseAnnotationSummaries, parseChangeSet } from './annotations';
import { parseSettings } from './app';
import { parseCite, parseTagDefs, parseTagNames, TAG_PALETTE, TAGS_MAX } from './cite';
import {
  createCitations,
  emptyBibRecord,
  fitsCitationExport,
  getBibliography,
  listCitations,
  parseBibliographyInfo,
  parseBibRecord,
  parseCitationInfo,
  parseCitationList,
  saveCitationList,
  setBibliography,
} from './citations';
import { toAppError } from './errors';
import { HIGHLIGHT_PALETTE } from '../features/inspector/palette';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const NOT_YET = {
  code: 'unsupported_feature',
  key: 'error.unsupported_feature',
  retryable: false,
  params: { what: 'notYet' },
};

const HISTORY = { canUndo: true, canRedo: false, undoLabel: 'citation.create', redoLabel: null, dirty: true };

const POINT = { x: 1, y: 2 };
const QUAD = [POINT, POINT, POINT, POINT];

const HIGHLIGHT = {
  id: 3,
  pageId: 0,
  rect: { x: 1, y: 2, w: 30, h: 10 },
  color: [220, 207, 255],
  opacity: 1,
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  locked: false,
  sync: 'new',
  kind: 'highlight',
  quads: [QUAD],
};

describe('the tag palette', () => {
  it('is the highlight palette of the inspector', () => {
    expect(TAG_PALETTE).toEqual(HIGHLIGHT_PALETTE.map((swatch) => swatch.rgb));
  });
});

describe('cite and tag shapes', () => {
  it('reads a cite record and refuses what is not one', () => {
    expect(parseCite({ quote: 'q', group: '0a1b2c3d' })).toEqual({ quote: 'q', group: '0a1b2c3d' });
    expect(parseCite({ quote: 'q', group: null })).toEqual({ quote: 'q' });
    expect(parseCite({ quote: '' })).toBeNull();
    expect(parseCite({ quote: 'x'.repeat(4_001) })).toBeNull();
    expect(parseCite({ quote: 'q', group: 7 })).toBeNull();
    expect(parseCite('q')).toBeNull();
  });

  it('keeps at most eight names and drops the ones that are not names', () => {
    expect(parseTagNames(undefined)).toEqual([]);
    expect(parseTagNames(['a', 3, '', 'b'])).toEqual(['a', 'b']);
    expect(parseTagNames(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(8);
  });

  it('reads tag definitions strictly', () => {
    expect(parseTagDefs([{ name: 'Method', color: [125, 235, 181] }])).toEqual([
      { name: 'Method', color: [125, 235, 181] },
    ]);
    expect(parseTagDefs([{ name: '', color: [1, 2, 3] }])).toBeNull();
    expect(parseTagDefs([{ name: 'a', color: [1, 2] }])).toBeNull();
    expect(parseTagDefs(Array.from({ length: TAGS_MAX + 1 }, () => ({ name: 'a', color: [1, 2, 3] })))).toBeNull();
    expect(parseTagDefs({})).toBeNull();
  });
});

describe('annotations with cite and tags', () => {
  it('still read when the backend sends neither key', () => {
    const annotation = parseAnnotation(HIGHLIGHT);
    expect(annotation).not.toBeNull();
    expect(annotation).not.toHaveProperty('cite');
    expect(annotation).not.toHaveProperty('tags');
  });

  it('carry a valid cite and tags, and a bad cite reads as a plain highlight', () => {
    const cited = parseAnnotation({ ...HIGHLIGHT, cite: { quote: 'Quote', group: 'abcd0123' }, tags: ['x', 4] });
    expect(cited?.cite).toEqual({ quote: 'Quote', group: 'abcd0123' });
    expect(cited?.tags).toEqual(['x']);
    const plain = parseAnnotation({ ...HIGHLIGHT, cite: { quote: 5 } });
    expect(plain).not.toBeNull();
    expect(plain).not.toHaveProperty('cite');
  });

  it('are summarized with tags and a cite flag', () => {
    const summary = {
      id: 3,
      pageId: 0,
      kind: 'highlight',
      color: [1, 2, 3],
      contents: '',
      author: null,
      modified: null,
      inReplyTo: null,
    };
    const [old, cited] = parseAnnotationSummaries([summary, { ...summary, id: 4, tags: ['a'], cite: true }]) ?? [];
    expect(old).not.toHaveProperty('cite');
    expect(old).not.toHaveProperty('tags');
    expect(cited?.cite).toBe(true);
    expect(cited?.tags).toEqual(['a']);
  });

  it('accept the bibliography part in a change set', () => {
    const base = { rev: 4, upserted: [], removed: [], pages: null, fields: [], history: HISTORY };
    expect(parseChangeSet({ ...base, doc: ['bibliography'] })?.doc).toEqual(['bibliography']);
    expect(parseChangeSet({ ...base, doc: ['bibliography', 'metadata', 'protection'] })?.doc).toHaveLength(3);
    expect(parseChangeSet({ ...base, doc: ['nope'] })).toBeNull();
  });
});

describe('settings with tags', () => {
  const base = {
    language: 'system',
    leftPanelWidth: 200,
    welcomeTour: 'pending',
    authorName: '',
    authorPrompt: 'pending',
  };

  it('read without the key and with a list', () => {
    expect(parseSettings(base)).not.toHaveProperty('tags');
    expect(parseSettings({ ...base, tags: [{ name: 'A', color: [255, 248, 77] }] })?.tags).toEqual([
      { name: 'A', color: [255, 248, 77] },
    ]);
  });
});

describe('the bibliographic record', () => {
  it('reads a partial record with null for what is missing', () => {
    const record = parseBibRecord({ kind: 'book', title: 'T', authors: [{ family: 'Müller', given: '' }] });
    expect(record).toEqual({
      ...emptyBibRecord(),
      kind: 'book',
      title: 'T',
      authors: [{ family: 'Müller', given: '' }],
    });
  });

  it('refuses an unknown kind, too many authors and too long fields', () => {
    expect(parseBibRecord({ kind: 'film' })).toBeNull();
    expect(
      parseBibRecord({ kind: 'book', authors: Array.from({ length: 33 }, () => ({ family: 'a', given: 'b' })) }),
    ).toBeNull();
    expect(parseBibRecord({ kind: 'book', year: 'x'.repeat(33) })).toBeNull();
    expect(parseBibRecord({ kind: 'book', doi: 5 })).toBeNull();
    expect(parseBibRecord(null)).toBeNull();
  });

  it('reads the answer of get_bibliography and drops unknown sources', () => {
    const info = parseBibliographyInfo({
      record: { ...emptyBibRecord(), title: 'T' },
      sources: { title: 'xmp', year: 'bogus', nonsense: 'user' },
      pending: false,
      droppedByStrip: true,
    });
    expect(info?.sources).toEqual({ title: 'xmp' });
    expect(info?.droppedByStrip).toBe(true);
    expect(
      parseBibliographyInfo({ record: emptyBibRecord(), sources: {}, pending: 'no', droppedByStrip: false }),
    ).toBeNull();
  });
});

describe('citations', () => {
  const info = {
    id: 5,
    pageId: 2,
    locator: 'xii',
    quote: 'Quote',
    contents: 'My comment',
    tags: ['a'],
    group: null,
    color: [220, 207, 255],
  };

  it('reads one and a list, and refuses a wrong shape', () => {
    expect(parseCitationInfo(info)).toEqual(info);
    expect(parseCitationInfo({ ...info, group: '' })).toBeNull();
    expect(parseCitationInfo({ ...info, locator: 12 })).toBeNull();
    expect(parseCitationInfo({ ...info, color: [1, 2] })).toBeNull();
    expect(parseCitationList([info, info])).toHaveLength(2);
    expect(parseCitationList([info, { id: 'x' }])).toBeNull();
    expect(parseCitationList('no')).toBeNull();
  });

  it('checks the size of a list before the backend does', () => {
    expect(fitsCitationExport([{ runs: [{ text: 'a', italic: false }] }])).toBe(true);
    expect(fitsCitationExport([{ runs: [{ text: 'a'.repeat(4_001), italic: false }] }])).toBe(false);
    expect(fitsCitationExport([{ runs: Array.from({ length: 65 }, () => ({ text: 'a', italic: true })) }])).toBe(false);
  });
});

describe('the four commands', () => {
  it('ask with camelCase arguments and parse the answers', async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await listCitations(7)).toEqual([]);
    expect(invokeMock).toHaveBeenLastCalledWith('list_citations', { docId: 7 });

    invokeMock.mockResolvedValueOnce({ record: emptyBibRecord(), sources: {}, pending: false, droppedByStrip: false });
    expect((await getBibliography(7)).record.kind).toBe('article');
    expect(invokeMock).toHaveBeenLastCalledWith('get_bibliography', { docId: 7 });

    invokeMock.mockResolvedValueOnce({ rev: 1, upserted: [], removed: [], pages: null, fields: [], history: HISTORY });
    await createCitations(7, [{ pageId: 0, quads: [], color: [220, 207, 255] }]);
    expect(invokeMock).toHaveBeenLastCalledWith('create_citations', {
      docId: 7,
      drafts: [{ pageId: 0, quads: [], color: [220, 207, 255] }],
    });

    invokeMock.mockResolvedValueOnce(true);
    expect(await saveCitationList(7, 'txt', [], 'apa7')).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith('save_citation_list', {
      docId: 7,
      format: 'txt',
      blocks: [],
      style: 'apa7',
    });
  });

  it('send the record as a document command', async () => {
    invokeMock.mockResolvedValueOnce({
      rev: 2,
      upserted: [],
      removed: [],
      pages: null,
      fields: [],
      history: HISTORY,
      doc: ['bibliography'],
    });
    const changes = await setBibliography(7, emptyBibRecord());
    expect(changes.doc).toEqual(['bibliography']);
    expect(invokeMock).toHaveBeenLastCalledWith('apply_command', {
      docId: 7,
      command: { type: 'setBibliography', record: emptyBibRecord() },
    });
  });

  it('turn a malformed answer into an internal error', async () => {
    invokeMock.mockResolvedValueOnce('nope');
    expect(toAppError(await listCitations(1).catch((e: unknown) => e)).code).toBe('internal');
    invokeMock.mockResolvedValueOnce('nope');
    expect(toAppError(await saveCitationList(1, 'bib', [], 'apa7').catch((e: unknown) => e)).code).toBe('internal');
  });

  it('surface the not-yet error of the backend seam', async () => {
    invokeMock.mockRejectedValueOnce(NOT_YET);
    const error = toAppError(await getBibliography(1).catch((e: unknown) => e));
    expect(error.code).toBe('unsupported_feature');
    expect(error.params?.what).toBe('notYet');
  });
});
