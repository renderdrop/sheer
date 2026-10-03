import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/annotations';
import type { Annotation, ChangeSet, HistoryState } from '../api/annotations';
import { annotationsOnPage, EMPTY_HISTORY, historyOf, isDirty, useAnnotations } from './annotations';

vi.mock('../api/annotations');

const mocked = vi.mocked(api);

function note(id: number, pageId = 0, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    pageId,
    rect: { x: 0, y: 0, w: 20, h: 20 },
    color: [255, 235, 0],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
    kind: 'note',
    at: { x: 0, y: 0 },
    icon: 'comment',
    ...extra,
  } as Annotation;
}

const history = (extra: Partial<HistoryState> = {}): HistoryState => ({ ...EMPTY_HISTORY, ...extra });
const changes = (rev: number, upserted: Annotation[] = [], removed: number[] = [], h = history()): ChangeSet => ({
  rev,
  upserted,
  removed,
  pages: null,
  history: h,
});
const docState = (docId: number) => useAnnotations.getState().byDoc[docId];

beforeEach(() => {
  vi.resetAllMocks();
  useAnnotations.setState({ byDoc: {} });
});

describe('loadPage', () => {
  it('loads the annotations of a page once and marks the page loaded', async () => {
    mocked.listAnnotations.mockResolvedValue([note(1), note(2)]);
    await useAnnotations.getState().loadPage(3, 0);
    await useAnnotations.getState().loadPage(3, 0);
    expect(mocked.listAnnotations).toHaveBeenCalledTimes(1);
    expect(mocked.listAnnotations).toHaveBeenCalledWith(3, 0);
    expect(docState(3)?.loaded).toEqual({ 0: true });
    expect(annotationsOnPage(useAnnotations.getState(), 3, 0).map((a) => a.id)).toEqual([1, 2]);
  });

  it('shares one request between callers that ask at the same time', async () => {
    mocked.listAnnotations.mockResolvedValue([note(1)]);
    await Promise.all([useAnnotations.getState().loadPage(3, 0), useAnnotations.getState().loadPage(3, 0)]);
    expect(mocked.listAnnotations).toHaveBeenCalledTimes(1);
  });

  it('keeps pages and documents apart', async () => {
    mocked.listAnnotations.mockImplementation((docId, pageId) => Promise.resolve([note(docId * 10 + pageId, pageId)]));
    await useAnnotations.getState().loadPage(1, 0);
    await useAnnotations.getState().loadPage(1, 1);
    await useAnnotations.getState().loadPage(2, 0);
    const state = useAnnotations.getState();
    expect(annotationsOnPage(state, 1, 1).map((a) => a.id)).toEqual([11]);
    expect(annotationsOnPage(state, 2, 0).map((a) => a.id)).toEqual([20]);
    expect(annotationsOnPage(state, 2, 1)).toEqual([]);
  });

  it('leaves the page unloaded after a failure, so a later call tries again', async () => {
    mocked.listAnnotations.mockRejectedValueOnce({ code: 'engine_timeout' }).mockResolvedValueOnce([note(1)]);
    await expect(useAnnotations.getState().loadPage(3, 0)).rejects.toMatchObject({ code: 'engine_timeout' });
    expect(docState(3)?.loaded[0]).toBeUndefined();
    await useAnnotations.getState().loadPage(3, 0);
    expect(annotationsOnPage(useAnnotations.getState(), 3, 0)).toHaveLength(1);
  });

  it('never overwrites or resurrects what the commands decided while the list was on its way', async () => {
    let answer: (value: Annotation[]) => void = () => undefined;
    mocked.listAnnotations.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const loading = useAnnotations.getState().loadPage(3, 0);
    // While it is on its way: annotation 1 is created and changed, annotation 2 is created and deleted.
    useAnnotations.getState().applyChanges(3, changes(1, [note(1), note(2)]));
    useAnnotations.getState().applyChanges(3, changes(2, [note(1, 0, { contents: 'new' })], [2]));
    answer([note(1), note(2), note(5)]);
    await loading;
    const ids = annotationsOnPage(useAnnotations.getState(), 3, 0).map((a) => a.id);
    expect(ids).toEqual([1, 5]);
    expect(docState(3)?.byId[1]?.contents).toBe('new');
  });
});

describe('applyChanges', () => {
  it('upserts, removes, and takes the revision and the history', () => {
    const { applyChanges } = useAnnotations.getState();
    applyChanges(
      1,
      changes(1, [note(1), note(2)], [], history({ canUndo: true, dirty: true, undoLabel: 'annotation.create' })),
    );
    applyChanges(1, changes(2, [note(1, 0, { contents: 'x' })], [2], history({ canUndo: true, dirty: true })));
    const doc = docState(1);
    expect(doc?.rev).toBe(2);
    expect(Object.keys(doc?.byId ?? {})).toEqual(['1']);
    expect(doc?.byId[1]?.contents).toBe('x');
    expect(historyOf(useAnnotations.getState(), 1).canUndo).toBe(true);
    expect(isDirty(useAnnotations.getState(), 1)).toBe(true);
  });

  it('ignores a change set older than the replica and takes an empty one for the same revision', () => {
    const { applyChanges } = useAnnotations.getState();
    applyChanges(1, changes(3, [note(1)], [], history({ canUndo: true, dirty: true })));
    applyChanges(1, changes(2, [], [1]));
    expect(docState(1)?.byId[1]).toBeDefined();
    expect(docState(1)?.rev).toBe(3);
    // An undo with nothing to undo answers with the current revision and the history: it is news for the flags only.
    applyChanges(1, changes(3, [], [], history({ canUndo: false, canRedo: true })));
    expect(historyOf(useAnnotations.getState(), 1)).toMatchObject({ canUndo: false, canRedo: true });
  });

  it('brings back an annotation an undo restores', () => {
    const { applyChanges } = useAnnotations.getState();
    applyChanges(1, changes(1, [note(1)]));
    applyChanges(1, changes(2, [], [1]));
    applyChanges(1, changes(3, [note(1)]));
    expect(annotationsOnPage(useAnnotations.getState(), 1, 0)).toHaveLength(1);
  });

  it('keeps documents apart', () => {
    const { applyChanges } = useAnnotations.getState();
    applyChanges(1, changes(1, [note(1)]));
    applyChanges(2, changes(1, [note(1, 0, { contents: 'other' })]));
    expect(docState(1)?.byId[1]?.contents).toBe('');
    expect(docState(2)?.byId[1]?.contents).toBe('other');
  });
});

describe('apply, undo and redo', () => {
  const command = { type: 'deleteAnnotations', ids: [1] } as const;

  it('run the backend command and apply what it answers', async () => {
    mocked.applyCommand.mockResolvedValue(changes(1, [note(1)], [], history({ canUndo: true, dirty: true })));
    const answer = await useAnnotations.getState().apply(4, command);
    expect(mocked.applyCommand).toHaveBeenCalledWith(4, command);
    expect(answer.rev).toBe(1);
    expect(docState(4)?.byId[1]).toBeDefined();

    mocked.undo.mockResolvedValue(changes(2, [], [1], history({ canRedo: true })));
    await useAnnotations.getState().undo(4);
    expect(mocked.undo).toHaveBeenCalledWith(4);
    expect(docState(4)?.byId[1]).toBeUndefined();
    expect(historyOf(useAnnotations.getState(), 4)).toMatchObject({ canUndo: false, canRedo: true });

    mocked.redo.mockResolvedValue(changes(3, [note(1)], [], history({ canUndo: true })));
    await useAnnotations.getState().redo(4);
    expect(mocked.redo).toHaveBeenCalledWith(4);
    expect(docState(4)?.byId[1]).toBeDefined();
    expect(docState(4)?.rev).toBe(3);
  });

  it('leave the replica as it was when the backend refuses, and pass the error on', async () => {
    mocked.applyCommand.mockResolvedValueOnce(changes(1, [note(1)]));
    await useAnnotations.getState().apply(4, command);
    const before = docState(4);
    mocked.applyCommand.mockRejectedValueOnce({ code: 'invalid_argument', params: { what: 'patch' } });
    await expect(useAnnotations.getState().apply(4, command)).rejects.toMatchObject({ code: 'invalid_argument' });
    mocked.undo.mockRejectedValueOnce({ code: 'engine_unavailable' });
    await expect(useAnnotations.getState().undo(4)).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(docState(4)).toBe(before);
  });
});

describe('selectors and remove', () => {
  it('give an empty history and no annotations for a document that is not known', () => {
    const state = useAnnotations.getState();
    expect(historyOf(state, null)).toBe(EMPTY_HISTORY);
    expect(historyOf(state, 9)).toBe(EMPTY_HISTORY);
    expect(isDirty(state, 9)).toBe(false);
    expect(annotationsOnPage(state, 9, 0)).toEqual([]);
    expect(annotationsOnPage(state, null, 0)).toEqual([]);
  });

  it('answer the same array while the annotations do not change', () => {
    useAnnotations.getState().applyChanges(1, changes(1, [note(1), note(2, 1)]));
    const state = useAnnotations.getState();
    expect(annotationsOnPage(state, 1, 0)).toBe(annotationsOnPage(state, 1, 0));
    expect(annotationsOnPage(state, 1, 1).map((a) => a.id)).toEqual([2]);
    // A change of the history alone does not change which annotations there are.
    useAnnotations.getState().applyChanges(1, changes(1, [], [], history({ canRedo: true })));
    expect(annotationsOnPage(useAnnotations.getState(), 1, 0)).toBe(annotationsOnPage(state, 1, 0));
  });

  it('orders a page by id', () => {
    useAnnotations.getState().applyChanges(1, changes(1, [note(9), note(3), note(5)]));
    expect(annotationsOnPage(useAnnotations.getState(), 1, 0).map((a) => a.id)).toEqual([3, 5, 9]);
  });

  it('forgets a closed document and nothing else', () => {
    useAnnotations.getState().applyChanges(1, changes(1, [note(1)]));
    useAnnotations.getState().applyChanges(2, changes(1, [note(1)]));
    useAnnotations.getState().remove(1);
    useAnnotations.getState().remove(7);
    expect(Object.keys(useAnnotations.getState().byDoc)).toEqual(['2']);
  });
});
