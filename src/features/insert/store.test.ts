import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet, ContentAnnotation } from '../../api/annotations';
import * as api from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { applyContentChanges, objectsOnPage, useInsert } from './store';

vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listContentObjects: vi.fn(),
}));
const mocked = vi.mocked(api);

const common = {
  pageId: 0,
  color: [0, 0, 0],
  opacity: 1,
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  locked: false,
  sync: 'new',
} as const;

function textBox(id: number, pageId = 0): ContentAnnotation {
  const box = { x: 10, y: 10, w: 160, h: 14.4 };
  return {
    ...common,
    pageId,
    id,
    rect: box,
    kind: 'textBox',
    box,
    text: 'Hello',
    lines: ['Hello'],
    font: 'sans',
    fontSize: 12,
    align: 'left',
  } as ContentAnnotation;
}

const change = (rev: number, content: ContentAnnotation[], removed: number[] = []): ChangeSet => ({
  rev,
  upserted: [],
  removed,
  pages: null,
  content,
  history: EMPTY_HISTORY,
});

beforeEach(() => {
  vi.resetAllMocks();
  useInsert.setState({ byDoc: {}, selected: {}, editing: null, pendingImage: null, arming: false });
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
});

describe('the content replica', () => {
  it('keeps text boxes and images from change sets, apart from the comments', () => {
    applyContentChanges(1, change(1, [textBox(5)]));
    expect(objectsOnPage(useInsert.getState(), 1, 0).map((o) => o.id)).toEqual([5]);
    expect(useAnnotations.getState().byDoc[1]?.byId[5]).toBeUndefined();
  });

  it('is fed by every change set of the annotation store (undo and redo included)', () => {
    useAnnotations.getState().applyChanges(1, change(1, [textBox(5)]));
    expect(objectsOnPage(useInsert.getState(), 1, 0)).toHaveLength(1);
    useAnnotations.getState().applyChanges(1, change(2, [], [5]));
    expect(objectsOnPage(useInsert.getState(), 1, 0)).toHaveLength(0);
  });

  it('drops removed objects and their selection', () => {
    applyContentChanges(1, change(1, [textBox(5)]));
    useInsert.getState().select(1, 5);
    applyContentChanges(1, change(2, [], [5]));
    expect(useInsert.getState().selected[1]).toBeNull();
  });

  it('ignores a change set older than the replica', () => {
    applyContentChanges(1, change(3, [textBox(5)]));
    applyContentChanges(1, change(2, [textBox(6)]));
    expect(objectsOnPage(useInsert.getState(), 1, 0).map((o) => o.id)).toEqual([5]);
  });

  it('hands out the same list while a page is unchanged', () => {
    applyContentChanges(1, change(1, [textBox(5), textBox(6, 1)]));
    const first = objectsOnPage(useInsert.getState(), 1, 0);
    expect(objectsOnPage(useInsert.getState(), 1, 0)).toBe(first);
    expect(objectsOnPage(useInsert.getState(), 1, 1)).toHaveLength(1);
  });

  it('ends an edit of an object that an undo took away', () => {
    applyContentChanges(1, change(1, [textBox(5)]));
    useInsert.getState().startEditing({ docId: 1, pageId: 0, id: 5, box: { x: 0, y: 0, w: 10, h: 10 } });
    applyContentChanges(1, change(2, [], [5]));
    expect(useInsert.getState().editing).toBeNull();
  });

  it('reads a page once and does not bring back what was removed meanwhile', async () => {
    let finish: (list: ContentAnnotation[]) => void = () => undefined;
    mocked.listContentObjects.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const load = useInsert.getState().loadPage(1, 0);
    applyContentChanges(1, change(1, [], [5]));
    finish([textBox(5), textBox(6)]);
    await load;
    expect(objectsOnPage(useInsert.getState(), 1, 0).map((o) => o.id)).toEqual([6]);
    await useInsert.getState().loadPage(1, 0);
    expect(mocked.listContentObjects).toHaveBeenCalledTimes(1);
  });

  it('forgets a closed document', () => {
    applyContentChanges(1, change(1, [textBox(5)]));
    useAnnotations.getState().remove(1);
    expect(objectsOnPage(useInsert.getState(), 1, 0)).toHaveLength(0);
  });
});
