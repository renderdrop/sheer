import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/annotations';
import type { Annotation, ChangeSet } from '../api/annotations';
import { annotationsOnPage, EMPTY_HISTORY, pageRevOf, useAnnotations } from './annotations';

vi.mock('../api/annotations');
const mocked = vi.mocked(api);

function note(id: number, pageId = 0, sync: Annotation['sync'] = 'new'): Annotation {
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
    sync,
    kind: 'note',
    at: { x: 0, y: 0 },
    icon: 'comment',
  } as Annotation;
}
const changes = (rev: number, upserted: Annotation[] = [], removed: number[] = []): ChangeSet => ({
  rev,
  upserted,
  removed,
  pages: null,
  history: EMPTY_HISTORY,
});
const store = () => useAnnotations.getState();

beforeEach(() => {
  vi.resetAllMocks();
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
});

describe('the selection lives on one page', () => {
  it('keeps the ids on the page of the first one', () => {
    store().applyChanges(1, changes(1, [note(1, 0), note(2, 0), note(3, 1)]));
    store().select(1, [2, 3, 1]);
    expect(store().selectedIds[1]).toEqual([2, 1]);
    store().select(1, [3, 1]);
    expect(store().selectedIds[1]).toEqual([3]);
  });

  it('takes ids it does not know yet as they are', () => {
    store().select(1, [8, 9]);
    expect(store().selectedIds[1]).toEqual([8, 9]);
  });
});

describe('the page lists', () => {
  it('give a page the same array when only another page changed', () => {
    store().applyChanges(1, changes(1, [note(1, 0), note(2, 1)]));
    const first = annotationsOnPage(store(), 1, 0);
    const second = annotationsOnPage(store(), 1, 1);
    store().applyChanges(1, changes(2, [{ ...note(2, 1), contents: 'x' }]));
    expect(annotationsOnPage(store(), 1, 0)).toBe(first);
    expect(annotationsOnPage(store(), 1, 1)).not.toBe(second);
    expect(annotationsOnPage(store(), 1, 1)[0]?.contents).toBe('x');
  });
});

describe('removed ids', () => {
  it('are not remembered while no page is loading, and a load in flight cannot bring one back', async () => {
    store().applyChanges(1, changes(1, [note(1)]));
    store().applyChanges(1, changes(2, [], [1]));
    expect(store().byDoc[1]?.removed).toEqual({});

    let finish: (list: Annotation[]) => void = () => undefined;
    mocked.listAnnotations.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const load = store().loadPage(1, 0);
    store().applyChanges(1, changes(3, [note(5)]));
    store().applyChanges(1, changes(4, [], [5]));
    expect(store().byDoc[1]?.removed).toEqual({ 5: true });
    finish([note(5)]);
    await load;
    expect(store().byDoc[1]?.byId[5]).toBeUndefined();
    // Nothing is in flight any more: the memory is dropped.
    expect(store().byDoc[1]?.removed).toEqual({});
  });
});

describe('page revisions', () => {
  it('grow when an annotation of the file changes, moves or goes, not for a new one', () => {
    store().applyChanges(1, changes(1, [note(1, 0, 'clean'), note(2, 0, 'clean'), note(3, 1, 'new')]));
    // The first answer is the load of what the file had: nothing before it was in a bitmap that changed.
    expect(pageRevOf(store(), 1, 0)).toBe(1);
    expect(pageRevOf(store(), 1, 1)).toBe(0);
    store().applyChanges(1, changes(2, [{ ...note(3, 1, 'new'), contents: 'y' }]));
    expect(pageRevOf(store(), 1, 1)).toBe(0);
    store().applyChanges(1, changes(3, [note(1, 0, 'modified')]));
    expect(pageRevOf(store(), 1, 0)).toBe(2);
    store().applyChanges(1, changes(4, [], [2]));
    expect(pageRevOf(store(), 1, 0)).toBe(3);
    store().remove(1);
    expect(pageRevOf(store(), 1, 0)).toBe(0);
  });
});
