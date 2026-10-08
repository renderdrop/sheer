// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation, ChangeSet } from '../../api/annotations';
import type { Quad } from '../../api/wire';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import {
  createCitationDrafts,
  createCitationFromSelection,
  isCitation,
  onCitationFocus,
  requestCitationFocus,
  selectionCitationDrafts,
} from './store';

const api = vi.hoisted(() => ({ createCitations: vi.fn(), listCitations: vi.fn() }));
vi.mock('../../api/citations', () => api);

const boundaries = vi.hoisted(() => ({
  start: { page: 7, index: 3 },
  end: { page: 8, index: 5 },
  calls: 0,
}));
vi.mock('../textlayer/selection', () => ({
  resolveBoundary: () => (boundaries.calls++ % 2 === 0 ? boundaries.start : boundaries.end),
}));
vi.mock('../textlayer/cache', () => ({ peekLayer: () => ({ text: 'x'.repeat(40) }) }));
const quadsFor = vi.hoisted(() => vi.fn());
vi.mock('../annotations/create/markup', () => ({ quadsForOffsets: quadsFor }));
vi.mock('../../stores/pages', () => ({
  positionOf: (_doc: number, page: number) => (page === 7 ? 0 : page === 8 ? 1 : null),
  pageIdAt: (_doc: number, position: number) => (position === 0 ? 7 : position === 1 ? 8 : null),
}));

const QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

function select(): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({
      startContainer: document.body,
      startOffset: 0,
      endContainer: document.body,
      endOffset: 0,
    }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
}

const changes = (pageId: number): ChangeSet =>
  ({
    rev: 5,
    removed: [],
    upserted: [{ id: 41, pageId, kind: 'highlight' } as unknown as Annotation],
    history: { canUndo: true, canRedo: false },
    pages: null,
  }) as unknown as ChangeSet;

beforeEach(() => {
  vi.restoreAllMocks();
  api.createCitations.mockReset();
  quadsFor.mockReset().mockReturnValue([QUAD]);
  boundaries.calls = 0;
  useDocuments.setState({ byId: { 1: { kind: 'file' } } } as never);
  useUi.setState({ toast: null, banner: null });
});

describe('isCitation', () => {
  it('is a highlight that carries a quote', () => {
    expect(isCitation({ kind: 'highlight', cite: { quote: 'q' } })).toBe(true);
    expect(isCitation({ kind: 'highlight' })).toBe(false);
    expect(isCitation({ kind: 'underline', cite: { quote: 'q' } })).toBe(false);
  });
});

describe('the drafts of a selection', () => {
  it('are none without a text selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 0, isCollapsed: true } as unknown as Selection);
    expect(selectionCitationDrafts(1)).toEqual([]);
  });

  it('are one per page, in the colour of the next citation (colour 5 first)', () => {
    select();
    const drafts = selectionCitationDrafts(1);
    expect(drafts.map((draft) => draft.pageId)).toEqual([7, 8]);
    expect(drafts[0]?.quads).toEqual([QUAD]);
    expect(drafts[0]?.color).toEqual([255, 65, 3]);
    // The first page runs from the start of the selection to the end of its text, the last from 0 to the end.
    expect(quadsFor.mock.calls.map(([, from, to]) => [from, to])).toEqual([
      [3, 40],
      [0, 5],
    ]);
  });

  it('leave out a page with no rectangles', () => {
    select();
    quadsFor.mockReturnValueOnce([]).mockReturnValueOnce([QUAD]);
    expect(selectionCitationDrafts(1).map((draft) => draft.pageId)).toEqual([8]);
  });
});

describe('createCitationFromSelection', () => {
  it('creates the drafts as one call, selects the new citation and clears the selection', async () => {
    select();
    api.createCitations.mockResolvedValue(changes(7));
    const apply = vi.spyOn(useAnnotations.getState(), 'applyChanges').mockImplementation(() => undefined);
    const select_ = vi.spyOn(useAnnotations.getState(), 'select').mockImplementation(() => undefined);
    await expect(createCitationFromSelection(1)).resolves.toBe(41);
    expect(api.createCitations).toHaveBeenCalledTimes(1);
    expect(api.createCitations.mock.calls[0]?.[1]).toHaveLength(2);
    expect(apply).toHaveBeenCalled();
    expect(select_).toHaveBeenCalledWith(1, [41]);
  });

  it('does nothing without a selection', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 0, isCollapsed: true } as unknown as Selection);
    await expect(createCitationFromSelection(1)).resolves.toBeNull();
    expect(api.createCitations).not.toHaveBeenCalled();
  });

  it('does nothing on a read-only document', async () => {
    select();
    useDocuments.setState({ byId: { 1: { kind: 'welcome' } } } as never);
    await expect(createCitationFromSelection(1)).resolves.toBeNull();
    expect(api.createCitations).not.toHaveBeenCalled();
  });

  it('says so in a toast when no text could be read', async () => {
    api.createCitations.mockRejectedValue({ code: 'invalid_argument', params: { what: 'citation' } });
    await expect(createCitationDrafts(1, [{ pageId: 7, quads: [QUAD], color: [220, 207, 255] }])).resolves.toBeNull();
    expect(useUi.getState().toast?.message).toMatch(/No text could be read/);
  });
});

describe('the focus request', () => {
  it('reaches the listener until it is removed', () => {
    const seen: number[] = [];
    const off = onCitationFocus((id) => seen.push(id));
    requestCitationFocus(4);
    off();
    requestCitationFocus(5);
    expect(seen).toEqual([4]);
  });
});
